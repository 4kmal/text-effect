import type { Metadata } from "next";

import ModelerStudio from "@/components/modeler/ModelerStudio";
import "@/components/modeler/modeler.css";
import "@/styles/editor-fonts.css";

export const metadata: Metadata = {
  title: "3D Model Studio | RapidScreen",
  description: "RapidScreen in-house 3D model and motion studio.",
  robots: { index: false, follow: false },
};

export default function ModelerPage() {
  return <ModelerStudio />;
}
