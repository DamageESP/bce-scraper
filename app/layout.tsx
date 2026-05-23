import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BdE → CRM",
  description: "Buscar entidades del Banco de España y añadirlas al CRM",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
