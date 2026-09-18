// The paper face is large enough to show a serif fallback on a cold load.
// Call after importing the page, so its @font-face rules are registered first.
// Keep the route's loading state until its actual fonts are ready to paint.
export async function loadInspirationFonts() {
  if (!document.fonts) return;
  const chinese = document.documentElement.lang.toLowerCase().startsWith('zh');
  const faces = chinese
    ? ['400 12px "ChillKai"']
    : ['400 12px "Courier Prime"', '700 12px "Courier Prime"', '400 12px "Source Han Serif CN"'];
  await Promise.allSettled(faces.map(face => document.fonts.load(face, '灵感 Spark Notes')));
}
