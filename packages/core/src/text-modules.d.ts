// .sql and .pem files are bundled as strings (esbuild `text` loader in Lambda, a Vite plugin in tests,
// a Node module hook for the tsx CLIs), so no code path reads them from the filesystem at runtime.
declare module '*.sql' {
  const text: string;
  export default text;
}

declare module '*.pem' {
  const text: string;
  export default text;
}
