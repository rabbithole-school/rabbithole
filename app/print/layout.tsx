export default function PrintLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <style>{`
        html,
        body {
          overflow: auto !important;
          height: auto !important;
        }

        @media print {
          html,
          body {
            overflow: visible !important;
            height: auto !important;
          }
        }
      `}</style>
      {children}
    </>
  );
}
