<?php
/**
 * Receives the cropped JPEG from the web app and uploads it to Cloudinary
 * using a signed request (the API secret never leaves the server).
 *
 * Request:  POST multipart/form-data, field "file", header "X-Upload-Key: <access_key>"
 * Response: JSON { url, width, height, bytes, public_id } or { error } with a 4xx/5xx status.
 */

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function respond(int $status, array $body): void
{
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_SLASHES);
    exit;
}

$configFile = __DIR__ . '/config.php';
if (!is_file($configFile)) {
    respond(500, ['error' => 'Server not configured: copy api/config.example.php to api/config.php.']);
}
$config = require $configFile;

foreach (['cloud_name', 'api_key', 'api_secret', 'access_key'] as $k) {
    if (empty($config[$k])) {
        respond(500, ['error' => "Server not configured: '$k' is missing in config.php."]);
    }
}

// --- CORS (only when the app lives on another origin) ---
$allowedOrigin = $config['allowed_origin'] ?? '';
if ($allowedOrigin !== '') {
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    if ($origin === $allowedOrigin) {
        header('Access-Control-Allow-Origin: ' . $allowedOrigin);
        header('Vary: Origin');
        header('Access-Control-Allow-Methods: POST, OPTIONS');
        header('Access-Control-Allow-Headers: X-Upload-Key');
        header('Access-Control-Max-Age: 86400');
    }
}
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    respond(204, []);
}
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    respond(405, ['error' => 'Use POST.']);
}

// --- Auth ---
$key = $_SERVER['HTTP_X_UPLOAD_KEY'] ?? '';
if (!is_string($key) || !hash_equals((string) $config['access_key'], $key)) {
    respond(401, ['error' => 'Invalid access key. Check ⚙ Settings in the app.']);
}

// --- Validate upload ---
if (empty($_FILES['file'])) {
    // Happens when the body exceeds PHP's post_max_size: PHP silently drops it.
    respond(413, ['error' => 'No file received (it may exceed the server\'s post_max_size / upload_max_filesize).']);
}
$file = $_FILES['file'];
if ($file['error'] !== UPLOAD_ERR_OK) {
    $msg = [
        UPLOAD_ERR_INI_SIZE  => 'File exceeds upload_max_filesize on the server.',
        UPLOAD_ERR_FORM_SIZE => 'File is too large.',
        UPLOAD_ERR_PARTIAL   => 'File was only partially uploaded.',
        UPLOAD_ERR_NO_FILE   => 'No file was uploaded.',
    ][$file['error']] ?? 'Upload error (code ' . $file['error'] . ').';
    respond(400, ['error' => $msg]);
}
$maxBytes = (int) ($config['max_bytes'] ?? 15 * 1024 * 1024);
if ($file['size'] > $maxBytes) {
    respond(413, ['error' => 'File is too large.']);
}
$info = @getimagesize($file['tmp_name']);
if ($info === false || !in_array($info[2], [IMAGETYPE_JPEG, IMAGETYPE_PNG, IMAGETYPE_WEBP], true)) {
    respond(415, ['error' => 'Only JPEG, PNG or WebP images are accepted.']);
}

// --- Build signed Cloudinary request ---
// Filename → public_id base (Cloudinary appends a random suffix via unique_filename).
$name = pathinfo((string) $file['name'], PATHINFO_FILENAME);
$name = trim(preg_replace('/[^A-Za-z0-9_-]+/', '-', $name) ?? '', '-');
if ($name === '') {
    $name = 'image';
}

$params = [
    'timestamp'       => time(),
    'use_filename'    => 'true',
    'unique_filename' => 'true',
    'overwrite'       => 'false',
];
$folder = trim((string) ($config['folder'] ?? ''), '/');
if ($folder !== '') {
    $params['folder'] = $folder;
}

// Signature: params sorted by key, joined as k=v&k=v, with the API secret appended, then SHA-1.
ksort($params);
$toSign = implode('&', array_map(fn($k, $v) => "$k=$v", array_keys($params), $params));
$params['signature'] = sha1($toSign . $config['api_secret']);
$params['api_key']   = $config['api_key'];
$params['file']      = new CURLFile($file['tmp_name'], $info['mime'], $name . image_type_to_extension($info[2]));

$endpoint = 'https://api.cloudinary.com/v1_1/' . rawurlencode((string) $config['cloud_name']) . '/image/upload';
$ch = curl_init($endpoint);
curl_setopt_array($ch, [
    CURLOPT_POST           => true,
    CURLOPT_POSTFIELDS     => $params,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_CONNECTTIMEOUT => 15,
    CURLOPT_TIMEOUT        => 120,
]);
$raw    = curl_exec($ch);
$status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
$curlErr = curl_error($ch);
curl_close($ch);

if ($raw === false) {
    respond(502, ['error' => 'Could not reach Cloudinary: ' . $curlErr]);
}
$data = json_decode((string) $raw, true);
if ($status < 200 || $status >= 300 || empty($data['secure_url'])) {
    $msg = $data['error']['message'] ?? ('HTTP ' . $status);
    respond(502, ['error' => 'Cloudinary: ' . $msg]);
}

respond(200, [
    'url'       => $data['secure_url'],
    'width'     => $data['width'] ?? null,
    'height'    => $data['height'] ?? null,
    'bytes'     => $data['bytes'] ?? null,
    'public_id' => $data['public_id'] ?? null,
]);
