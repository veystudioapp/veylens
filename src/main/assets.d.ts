/** A PNG imported by the main process: esbuild inlines it as a data URL. */
declare module "*.png" {
  const dataUrl: string
  export default dataUrl
}
