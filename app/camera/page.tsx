import type { Metadata } from "next";

import CameraFxLab from "@/components/camera/CameraFxLab";
import "@/components/camera/camera.css";
import "@/styles/editor-fonts.css";

export const metadata: Metadata = {
  title: "Camera FX Lab | RapidScreen",
  description: "RapidScreen in-house webcam effects studio.",
  robots: {
    index: false,
    follow: false,
  },
};

export default function CameraPage() {
  return <CameraFxLab />;
}
