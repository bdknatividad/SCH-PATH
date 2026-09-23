/// <reference types="vite/client" />

declare module '*.css' {
  const content: { [className: string]: string };
  export default content;
}

// Idagdag mo itong dalawang linya sa ibaba:
declare module '*.png';
declare module '*.jpg';