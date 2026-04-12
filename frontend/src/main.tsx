import React from "react";
import ReactDOM from "react-dom/client";

import "vidstack/define/media-player";
import "vidstack/define/media-outlet";
import "vidstack/define/media-community-skin";
import "vidstack/styles/base.css";
import "vidstack/styles/defaults.css";
import "vidstack/styles/ui/buttons.css";
import "vidstack/styles/ui/sliders.css";
import "vidstack/styles/ui/menus.css";
import "vidstack/styles/ui/tooltips.css";
import "vidstack/styles/ui/buffering.css";
import "vidstack/styles/ui/live.css";
import "vidstack/styles/ui/captions.css";
import "vidstack/styles/community-skin/video.css";

import { App } from "./App";
import "./styles/index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
