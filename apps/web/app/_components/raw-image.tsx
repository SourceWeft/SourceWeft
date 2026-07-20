// The component itself lives in the shared UI package so capability packages
// can render remote assets without reaching into the app. Kept as a re-export
// so the app's existing import paths stay valid.
export { RawImage, type RawImageProps } from "@sourceweft/ui-web/raw-image";
