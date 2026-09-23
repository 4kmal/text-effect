import type { Metadata } from "next";

import "@/styles/editor-fonts.css";
import "@/components/editor/editor.css";

import EditorStudio from "@/components/editor/EditorStudio";

export const metadata: Metadata = {
  title: "Text FX Lab | RapidScreen",
  description: "RapidScreen in-house animated text editor.",
  robots: {
    index: false,
    follow: false,
  },
};

export default function EditorPage() {
  return <EditorStudio />;
}
