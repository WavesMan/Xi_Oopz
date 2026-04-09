import type { DetailedHTMLProps, HTMLAttributes } from "react";

type CustomElementProps = DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
  src?: string;
  title?: string;
  viewType?: string;
  streamType?: string;
  load?: string;
  preload?: string;
  controls?: boolean;
  playsinline?: boolean;
  crossorigin?: boolean;
  "aspect-ratio"?: string;
  class?: string;
};

declare module "react/jsx-runtime" {
  namespace JSX {
    interface IntrinsicElements {
      "media-player": CustomElementProps;
      "media-outlet": DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement>;
      "media-community-skin": DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement>;
    }
  }
}
