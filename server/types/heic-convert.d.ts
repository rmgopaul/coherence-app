declare module "heic-convert" {
  interface HeicConvertOptions {
    buffer: Buffer;
    format: "JPEG" | "PNG";
    quality?: number;
  }
  const convert: (options: HeicConvertOptions) => Promise<ArrayBuffer>;
  export default convert;
}
