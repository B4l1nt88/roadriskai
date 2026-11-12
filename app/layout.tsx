import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Budapest H3 Spatio-Temporal Accident Risk Platform",
  description: "Valós idejű, 15 perces felbontású közlekedési baleseti kockázat-előrejelző rendszer (Uber H3 Res-8, BKK FUTÁR GTFS-RT, Open-Meteo, LightGBM ONNX).",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="hu" className="dark">
      <body className="antialiased bg-[#090d16] text-slate-100 min-h-screen">
        {children}
      </body>
    </html>
  );
}

