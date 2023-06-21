<?php

$nightlyVersion = [];
$nightlyEndpoint = "https://api-nightly.prestashop-project.org/reports";

$targetBranch = $argv[1];
$reports = json_decode(file_get_contents($nightlyEndpoint), true);
$currentDate = "";
$zipFiles = [];
foreach ($reports as $report) {
    if ($report['version'] !== $targetBranch || null === $report['download']) {
        continue;
    }

    $nightlyVersion = [
        "version" => getVersionFromFilename($report['download']),
        "zip" => $report['download'],
        "xml" => $report['xml'],
    ];

    break;
}

if (empty($nightlyVersion)) {
    throw new \RuntimeException('Could not find version details for branch ' . $targetBranch);
}

function getVersionFromFilename($filename) {
    $matches = [];
    preg_match('/^.*prestashop_(.*)\.zip$/', $filename, $matches);

    return $matches[1];
}

echo json_encode($nightlyVersion);
