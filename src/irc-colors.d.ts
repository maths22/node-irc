declare module 'irc-colors' {
  export function stripColors(input: string): string;
  export function stripStyles(input: string): string;
  export function stripColorsAndStyle(input: string): string;
}