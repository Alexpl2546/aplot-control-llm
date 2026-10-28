import React from "react";
import ReactDOM from "react-dom/client";
import "./lib/i18n";
import "./styles/kontur/index.css";
import App from "./App";
import { MiniApp } from "./features/mini/MiniApp";

/** The same bundle serves the main window and the always-on-top mini window (`?mini=1`). */
const mini = new URLSearchParams(window.location.search).get("mini") === "1";
if (mini) document.documentElement.dataset.window = "mini";
ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode>{mini ? <MiniApp/> : <App/>}</React.StrictMode>);
