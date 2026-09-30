import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Олимпус",
  description: "Олимпиадная подготовка для школьников 4–6 классов",
  icons: {
    icon: "/olympus-favicon.png",
    shortcut: "/olympus-favicon.png",
    apple: "/olympus-icon-512.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f7fc" },
    { media: "(prefers-color-scheme: dark)", color: "#0f141d" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru">
      <head>
        {/*
          MAX Bridge, connected as the official docs show: a plain synchronous script, so
          `window.WebApp` exists before the app starts and reads its launch data from the
          URL before the app's router rewrites the hash. Outside MAX it is inert.
        */}
        <script src="https://st.max.ru/js/max-web-app.js" />
      </head>
      <body>{children}</body>
    </html>
  );
}
