<?php
// Copy this file to config.php and fill in your values.
// config.php holds secrets: never commit it or expose it publicly.

return [
    // Cloudinary Console → Settings → API Keys (or the dashboard).
    'cloud_name' => 'your-cloud-name',
    'api_key'    => '123456789012345',
    'api_secret' => 'your-api-secret',

    // Optional folder in your Media Library ('' = root).
    'folder' => 'emails',

    // Shared secret the web app must send (entered once in the app's ⚙ Settings).
    // Use a long random string, e.g. from: php -r 'echo bin2hex(random_bytes(24));'
    'access_key' => 'change-me-to-a-long-random-string',

    // Only needed if the app is served from a DIFFERENT domain than this PHP file,
    // e.g. 'https://cropper.example.com'. Leave '' when both are on the same site.
    'allowed_origin' => '',

    // Reject uploads larger than this (bytes). The app sends ~0.2–2 MB JPEGs.
    'max_bytes' => 15 * 1024 * 1024,
];
