declare module "@babel/standalone" {
  export function transform(
    code: string,
    options: {
      filename?: string;
      presets?: string[];
    },
  ): {
    code?: string | null;
  };
}
