export const ARTWORK_SIZE = 1080;

const TAG_EDGE_OFFSET = 40;
const TAG_MIN_WIDTH = 360;
const TAG_BORDER = 4;
const TAG_PADDING = 8;
const TAG_HEADER_HEIGHT = 64;
const TAG_BODY_HEIGHT = 104;
const TAG_DIVIDER_HEIGHT = 4;
const TAG_CONTENT_INSET = TAG_BORDER + TAG_PADDING;
const LOGO_WIDTH = 156;
const LOGO_HEIGHT = 38;
const MAIN_FONT_SIZE = 36;
const FOOTER_FONT_SIZE = 24;
const CITY_FONT_SIZE = 22;

type ArtworkTheme = {
  name: ArtworkThemeName;
  background: string;
  foreground: string;
  logoPath: string;
};

export const ARTWORK_THEME_NAMES = ["blue", "orange", "white", "dark"] as const;
export type ArtworkThemeName = (typeof ARTWORK_THEME_NAMES)[number];

const ARTWORK_THEMES: ArtworkTheme[] = [
  { name: "blue", background: "#4ec5ec", foreground: "#25282c", logoPath: "/branding/logo-stamp-black.png" },
  { name: "orange", background: "#ff6500", foreground: "#25282c", logoPath: "/branding/logo-stamp-black.png" },
  { name: "white", background: "#f5f5f2", foreground: "#25282c", logoPath: "/branding/logo-stamp-black.png" },
  { name: "dark", background: "#25282c", foreground: "#f5f5f2", logoPath: "/branding/logo-stamp-white.png" },
];

export type ResidentArtworkProfile = {
  producerName: string;
  radioShow: string | null;
  city: string | null;
  profilePictureUrl: string | null;
};

export type ShowArtworkDetails = {
  producerName: string;
  radioShow: string;
  city: string;
  startsAt: string | null;
  endsAt: string | null;
};

function loadBrowserImage(source: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The artwork image could not be read."));
    image.src = source;
  });
}

function formatArtworkDateTime(startsAt: string | null, endsAt: string | null) {
  if (!startsAt) return "PARANOISE RADIO";
  const start = new Date(startsAt);
  if (Number.isNaN(start.getTime())) return "PARANOISE RADIO";

  const dateLabel = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    timeZone: "Europe/Athens",
  }).format(start);
  const timeFormatter = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "Europe/Athens",
  });
  const startTime = timeFormatter.format(start);
  const end = endsAt ? new Date(endsAt) : null;
  const endTime = end && !Number.isNaN(end.getTime()) ? ` - ${timeFormatter.format(end)}` : "";
  return `${dateLabel} ${startTime}${endTime} (GR)`;
}

function visibleTextHeight(metrics: TextMetrics) {
  return Math.ceil(metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent);
}

function visibleTextBaseline(top: number, metrics: TextMetrics) {
  return top + metrics.actualBoundingBoxAscent;
}

function drawCoverCrop(context: CanvasRenderingContext2D, sourceImage: HTMLImageElement) {
  const imageScale = Math.max(ARTWORK_SIZE / sourceImage.width, ARTWORK_SIZE / sourceImage.height);
  const imageWidth = sourceImage.width * imageScale;
  const imageHeight = sourceImage.height * imageScale;
  context.drawImage(
    sourceImage,
    (ARTWORK_SIZE - imageWidth) / 2,
    (ARTWORK_SIZE - imageHeight) / 2,
    imageWidth,
    imageHeight,
  );
}

function drawEpisodeTag(
  context: CanvasRenderingContext2D,
  logo: HTMLImageElement,
  theme: ArtworkTheme,
  details: ShowArtworkDetails,
) {
  const producerName = details.producerName.trim().toUpperCase();
  const radioShow = details.radioShow.trim().toUpperCase();
  const city = details.city.trim().toUpperCase();
  const footer = formatArtworkDateTime(details.startsAt, details.endsAt);

  context.textBaseline = "alphabetic";
  context.font = `500 ${MAIN_FONT_SIZE}px "Favoritpro", Arial, sans-serif`;
  const producerMetrics = context.measureText(producerName);
  const showMetrics = context.measureText(radioShow);
  context.font = `500 ${CITY_FONT_SIZE}px "Favoritpro", Arial, sans-serif`;
  const cityMetrics = context.measureText(city);
  context.font = `500 ${FOOTER_FONT_SIZE}px "Favoritpro", Arial, sans-serif`;
  const footerMetrics = context.measureText(footer);

  const cityWidth = Math.ceil(cityMetrics.width + TAG_PADDING * 2);
  const headerWidth = TAG_CONTENT_INSET + LOGO_WIDTH + 12 + cityWidth + TAG_CONTENT_INSET;
  const contentWidth = Math.max(producerMetrics.width, showMetrics.width, footerMetrics.width)
    + TAG_CONTENT_INSET * 2;
  const tagWidth = Math.ceil(Math.max(TAG_MIN_WIDTH, headerWidth, contentWidth));
  const footerTextHeight = visibleTextHeight(footerMetrics);
  const footerHeight = TAG_DIVIDER_HEIGHT + TAG_PADDING + footerTextHeight + TAG_PADDING + TAG_BORDER;
  const tagHeight = TAG_HEADER_HEIGHT + TAG_BODY_HEIGHT + footerHeight;
  const tagX = ARTWORK_SIZE - TAG_EDGE_OFFSET - tagWidth;
  const tagY = ARTWORK_SIZE - TAG_EDGE_OFFSET - tagHeight;
  const headerDividerY = tagY + TAG_HEADER_HEIGHT - TAG_DIVIDER_HEIGHT;
  const footerDividerY = tagY + TAG_HEADER_HEIGHT + TAG_BODY_HEIGHT;

  context.fillStyle = theme.background;
  context.fillRect(tagX, tagY, tagWidth, tagHeight);
  context.strokeStyle = theme.foreground;
  context.lineWidth = TAG_BORDER;
  context.strokeRect(
    tagX + TAG_BORDER / 2,
    tagY + TAG_BORDER / 2,
    tagWidth - TAG_BORDER,
    tagHeight - TAG_BORDER,
  );
  context.fillStyle = theme.foreground;
  context.fillRect(tagX, headerDividerY, tagWidth, TAG_DIVIDER_HEIGHT);
  context.fillRect(tagX, footerDividerY, tagWidth, TAG_DIVIDER_HEIGHT);

  context.drawImage(
    logo,
    tagX + TAG_CONTENT_INSET,
    tagY + (TAG_HEADER_HEIGHT - TAG_DIVIDER_HEIGHT - LOGO_HEIGHT) / 2,
    LOGO_WIDTH,
    LOGO_HEIGHT,
  );

  const cityX = tagX + tagWidth - TAG_CONTENT_INSET - cityWidth;
  const cityY = tagY + (TAG_HEADER_HEIGHT - TAG_DIVIDER_HEIGHT - 34) / 2;
  context.fillRect(cityX, cityY, cityWidth, 34);
  context.fillStyle = theme.background;
  context.font = `500 ${CITY_FONT_SIZE}px "Favoritpro", Arial, sans-serif`;
  context.textAlign = "center";
  const cityBaseline = cityY + (34 - visibleTextHeight(cityMetrics)) / 2 + cityMetrics.actualBoundingBoxAscent;
  context.fillText(city, cityX + cityWidth / 2, cityBaseline);

  context.fillStyle = theme.foreground;
  context.textAlign = "left";
  context.font = `500 ${MAIN_FONT_SIZE}px "Favoritpro", Arial, sans-serif`;
  const bodyTop = headerDividerY + TAG_DIVIDER_HEIGHT;
  const producerTop = bodyTop + TAG_PADDING;
  context.fillText(producerName, tagX + TAG_CONTENT_INSET, visibleTextBaseline(producerTop, producerMetrics));
  const showTop = producerTop + 42;
  context.fillText(radioShow, tagX + TAG_CONTENT_INSET, visibleTextBaseline(showTop, showMetrics));

  const footerTop = footerDividerY + TAG_DIVIDER_HEIGHT + TAG_PADDING;
  context.font = `500 ${FOOTER_FONT_SIZE}px "Favoritpro", Arial, sans-serif`;
  context.fillText(footer, tagX + TAG_CONTENT_INSET, visibleTextBaseline(footerTop, footerMetrics));
}

export async function createShowArtwork(
  sourceFile: Blob,
  details: ShowArtworkDetails,
  themeName?: ArtworkThemeName,
) {
  const theme = themeName
    ? ARTWORK_THEMES.find((candidate) => candidate.name === themeName) ?? ARTWORK_THEMES[0]
    : ARTWORK_THEMES[Math.floor(Math.random() * ARTWORK_THEMES.length)];
  const sourceUrl = URL.createObjectURL(sourceFile);
  try {
    const [sourceImage, logo] = await Promise.all([
      loadBrowserImage(sourceUrl),
      loadBrowserImage(theme.logoPath),
      document.fonts.load(`500 ${MAIN_FONT_SIZE}px "Favoritpro"`),
      document.fonts.load(`500 ${FOOTER_FONT_SIZE}px "Favoritpro"`),
    ]);
    const canvas = document.createElement("canvas");
    canvas.width = ARTWORK_SIZE;
    canvas.height = ARTWORK_SIZE;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Artwork generation is not supported by this browser.");

    drawCoverCrop(context, sourceImage);
    drawEpisodeTag(context, logo, theme, details);

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (result) => result ? resolve(result) : reject(new Error("The artwork could not be exported.")),
        "image/jpeg",
        0.94,
      );
    });
    const safeTitle = details.radioShow.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "show";
    return new File([blob], `${safeTitle}-artwork.jpg`, { type: "image/jpeg" });
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}
