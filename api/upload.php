<?php
/**
 * Receives the cropped JPEG from the web app and uploads it to Cloudinary
 * using a signed request (the API secret never leaves the server).
 *
 * Request:  POST multipart/form-data, field "file", header "X-Requested-With: imgcropper"
 * Response: JSON { url, width, height, bytes, public_id } or { error } with a 4xx/5xx status.
 *
 * There is no password. Instead, layered checks make the endpoint useless for anything
 * except what the app does:
 *   1. Same-site only: the request's Origin (or Referer) must be this host (or allowed_origin).
 *      Stops other websites from using it through visitors' browsers.
 *   2. A custom header is required. Browsers can't send it cross-site without a CORS
 *      preflight, which this script only approves for allowed_origin.
 *   3. Per-IP rate limit (rate_limit_per_hour).
 *   4. Only JPEGs no wider than 1280 px (what the app produces) are accepted, so it can't be
 *      used to host arbitrary or large files. Cloudinary parameters are fixed server-side.
 * A determined attacker with curl can fake 1 and 2; 3 and 4 cap what they can do.
 */

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Robots-Tag: noindex, nofollow');

function respond(int $status, array $body): void
{
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_SLASHES);
    exit;
}

/** "host[:port]" the request came from, from Origin or (fallback) Referer; '' if unknown. */
function requestSourceHost(): string
{
    foreach ([$_SERVER['HTTP_ORIGIN'] ?? '', $_SERVER['HTTP_REFERER'] ?? ''] as $url) {
        if ($url === '' || $url === 'null') {
            continue;
        }
        $p = parse_url($url);
        if (!empty($p['host'])) {
            return strtolower($p['host'] . (isset($p['port']) ? ':' . $p['port'] : ''));
        }
    }
    return '';
}

/** Sliding-window rate limit per client IP. Fails open if the storage isn't writable. */
function rateLimited(string $ip, int $limit, int $window = 3600): bool
{
    if ($limit <= 0) {
        return false;
    }
    $dir = __DIR__ . '/.ratelimit';
    if (!is_dir($dir) && !@mkdir($dir, 0700, true)) {
        return false;
    }
    if (!is_file("$dir/.htaccess")) {
        @file_put_contents("$dir/.htaccess", "Require all denied\n");
    }
    $fh = @fopen($dir . '/' . hash('sha256', $ip) . '.json', 'c+');
    if (!$fh) {
        return false;
    }
    flock($fh, LOCK_EX);
    $now = time();
    $hits = json_decode((string) stream_get_contents($fh), true);
    $hits = array_values(array_filter(is_array($hits) ? $hits : [], fn($t) => is_int($t) && $t > $now - $window));
    $limited = count($hits) >= $limit;
    if (!$limited) {
        $hits[] = $now;
    }
    ftruncate($fh, 0);
    rewind($fh);
    fwrite($fh, json_encode($hits));
    flock($fh, LOCK_UN);
    fclose($fh);
    return $limited;
}

$configFile = __DIR__ . '/config.php';
if (!is_file($configFile)) {
    respond(500, ['error' => 'Server not configured: copy api/config.example.php to api/config.php.']);
}
$config = require $configFile;

foreach (['cloud_name', 'api_key', 'api_secret'] as $k) {
    if (empty($config[$k])) {
        respond(500, ['error' => "Server not configured: '$k' is missing in config.php."]);
    }
}

// --- CORS (only when the app lives on another origin, configured via allowed_origin) ---
$allowedOrigin = rtrim((string) ($config['allowed_origin'] ?? ''), '/');
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($allowedOrigin !== '' && $origin === $allowedOrigin) {
    header('Access-Control-Allow-Origin: ' . $allowedOrigin);
    header('Vary: Origin');
    header('Access-Control-Allow-Methods: POST, OPTIONS');
    header('Access-Control-Allow-Headers: X-Requested-With');
    header('Access-Control-Max-Age: 86400');
}
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    respond(204, []);
}
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    respond(405, ['error' => 'Use POST.']);
}

// --- 1 & 2: same-site request from the app ---
$ownHost = strtolower((string) ($_SERVER['HTTP_HOST'] ?? ''));
$allowedHost = $allowedOrigin !== '' ? strtolower((string) (parse_url($allowedOrigin, PHP_URL_HOST) ?? '')
    . (parse_url($allowedOrigin, PHP_URL_PORT) ? ':' . parse_url($allowedOrigin, PHP_URL_PORT) : '')) : '';
$source = requestSourceHost();
$sameSite = $source !== '' && ($source === $ownHost || ($allowedHost !== '' && $source === $allowedHost));
if (!$sameSite || ($_SERVER['HTTP_X_REQUESTED_WITH'] ?? '') !== 'imgcropper') {
    respond(403, ['error' => 'Forbidden.']);
}

// --- 3: rate limit ---
if (rateLimited((string) ($_SERVER['REMOTE_ADDR'] ?? 'unknown'), (int) ($config['rate_limit_per_hour'] ?? 60))) {
    header('Retry-After: 3600');
    respond(429, ['error' => 'Too many uploads from this network in the last hour. Try again later.']);
}

// --- 4: validate upload ---
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
$maxBytes = (int) ($config['max_bytes'] ?? 10 * 1024 * 1024);
if ($file['size'] > $maxBytes) {
    respond(413, ['error' => 'File is too large.']);
}
$info = @getimagesize($file['tmp_name']);
if ($info === false || $info[2] !== IMAGETYPE_JPEG) {
    respond(415, ['error' => 'Only JPEG images are accepted.']);
}
// The app never sends anything wider than 1280 px; the height cap allows very tall free-form crops.
if ($info[0] < 1 || $info[0] > 1280 || $info[1] < 1 || $info[1] > 16000) {
    respond(422, ['error' => 'Unexpected image dimensions.']);
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
$params['file']      = new CURLFile($file['tmp_name'], 'image/jpeg', $name . '.jpg');

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
