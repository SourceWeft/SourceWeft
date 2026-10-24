// Single source of truth for where preview vendor assets are served. The
// version is part of the URL so the files can be cached as immutable; bump it
// whenever the installed @file-viewer asset packages change (tests/assets
// enforce that it matches the installed versions).
export const FILE_VIEWER_ASSET_VERSION = "std-3.0.3_ppt-3.0.3";
export const FILE_VIEWER_ASSET_BASE_URL = `/file-viewer/${FILE_VIEWER_ASSET_VERSION}/`;
