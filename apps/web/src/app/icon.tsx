import { ImageResponse } from "next/og";

// Favicon — the Converse360 "C" in brand green on a transparent
// background. The path is lifted verbatim from the brand wordmark
// (public/brand/converse360-mark.svg), so the tab icon and the collapsed
// rail mark are the same glyph rather than two drifting approximations.
// Green reads on both light and dark browser chrome, so no plate here.
// Next.js renders this at build time and auto-injects <link rel="icon">.

export const runtime = "edge";
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

/** Leading "C" of the wordmark. Occupies x 160–248, y 291–390. */
const MARK_PATH =
  "M207.71,390.05c-6.86,0-13.18-1.24-18.97-3.73-5.79-2.49-10.85-5.96-15.18-10.42-4.33-4.46-7.7-9.69-10.1-15.69-2.4-6-3.6-12.56-3.6-19.68s1.18-13.7,3.54-19.74c2.36-6.05,5.7-11.27,10.03-15.69,4.33-4.42,9.41-7.85,15.24-10.29,5.83-2.44,12.18-3.67,19.04-3.67s13.01,1.16,18.46,3.47c5.44,2.32,10.05,5.38,13.83,9.2,3.77,3.82,6.47,8,8.1,12.54l-15.69,7.33c-1.8-4.8-4.85-8.77-9.13-11.9-4.29-3.13-9.48-4.7-15.56-4.7s-11.3,1.42-15.89,4.25c-4.59,2.83-8.15,6.73-10.68,11.7-2.53,4.97-3.79,10.8-3.79,17.49s1.26,12.54,3.79,17.56c2.53,5.02,6.09,8.94,10.68,11.77,4.59,2.83,9.88,4.24,15.89,4.24s11.28-1.56,15.56-4.69c4.29-3.13,7.33-7.09,9.13-11.9l15.69,7.33c-1.63,4.55-4.33,8.73-8.1,12.54-3.77,3.82-8.38,6.88-13.83,9.2-5.45,2.32-11.6,3.47-18.46,3.47Z";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {/* Square viewBox centred on the glyph — same crop as the rail mark. */}
        <svg width="30" height="30" viewBox="149 285.6 110 110" fill="#00ac55">
          <path d={MARK_PATH} />
        </svg>
      </div>
    ),
    { ...size },
  );
}
