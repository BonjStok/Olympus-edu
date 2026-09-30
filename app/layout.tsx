import type { Metadata, Viewport } from "next";
import Script from "next/script";
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
          Load the MAX bridge before React becomes interactive. On a cold Android launch,
          rendering the app before this script is ready makes it start as a guest.
        */}
        <Script src="https://st.max.ru/js/max-web-app.js" strategy="beforeInteractive" />
      </head>
      <body>{children}</body>
    </html>
  );
}
