export const ARTWORK_SIZE = 1080;
export const STORY_ARTWORK_WIDTH = 1080;
export const STORY_ARTWORK_HEIGHT = 1920;

const TAG_EDGE_OFFSET = 40;
const TAG_MIN_WIDTH = 360;
const TAG_BORDER = 4;
const TAG_PADDING = 8;
const TAG_HEADER_HEIGHT = 64;
const TAG_BODY_HEIGHT = 104;
const TAG_DIVIDER_HEIGHT = 4;
const TAG_CONTENT_INSET = TAG_BORDER + TAG_PADDING;
const CONTENT_SCALE = 1.1;
const BASE_LOGO_WIDTH = 156;
const BASE_LOGO_HEIGHT = 38;
const LOGO_WIDTH = BASE_LOGO_WIDTH * CONTENT_SCALE;
const LOGO_HEIGHT = BASE_LOGO_HEIGHT * CONTENT_SCALE;
const BASE_MAIN_FONT_SIZE = 36;
const BASE_FOOTER_FONT_SIZE = 24;
const BASE_CITY_FONT_SIZE = 22;
const MAIN_FONT_SIZE = BASE_MAIN_FONT_SIZE * CONTENT_SCALE;
const FOOTER_FONT_SIZE = BASE_FOOTER_FONT_SIZE * CONTENT_SCALE;
const CITY_FONT_SIZE = BASE_CITY_FONT_SIZE * CONTENT_SCALE;

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

function drawCoverCrop(
  context: CanvasRenderingContext2D,
  sourceImage: HTMLImageElement,
  outputWidth: number,
  outputHeight: number,
) {
  const imageScale = Math.max(outputWidth / sourceImage.width, outputHeight / sourceImage.height);
  const imageWidth = sourceImage.width * imageScale;
  const imageHeight = sourceImage.height * imageScale;
  context.drawImage(
    sourceImage,
    (outputWidth - imageWidth) / 2,
    (outputHeight - imageHeight) / 2,
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
  context.font = `500 ${BASE_MAIN_FONT_SIZE}px "Favoritpro", Arial, sans-serif`;
  const baseProducerMetrics = context.measureText(producerName);
  const baseShowMetrics = context.measureText(radioShow);
  context.font = `500 ${MAIN_FONT_SIZE}px "Favoritpro", Arial, sans-serif`;
  const producerMetrics = context.measureText(producerName);
  const showMetrics = context.measureText(radioShow);
  context.font = `500 ${BASE_CITY_FONT_SIZE}px "Favoritpro", Arial, sans-serif`;
  const baseCityMetrics = context.measureText(city);
  context.font = `500 ${CITY_FONT_SIZE}px "Favoritpro", Arial, sans-serif`;
  const cityMetrics = context.measureText(city);
  context.font = `500 ${FOOTER_FONT_SIZE}px "Favoritpro", Arial, sans-serif`;
  const footerMetrics = context.measureText(footer);

  const headerHeight = TAG_HEADER_HEIGHT + (LOGO_HEIGHT - BASE_LOGO_HEIGHT);
  const cityHeight = 34 + visibleTextHeight(cityMetrics) - visibleTextHeight(baseCityMetrics);
  const cityWidth = Math.ceil(cityMetrics.width + TAG_PADDING * 2);
  const headerWidth = TAG_CONTENT_INSET + LOGO_WIDTH + 12 + cityWidth + TAG_CONTENT_INSET;
  const contentWidth = Math.max(producerMetrics.width, showMetrics.width, footerMetrics.width)
    + TAG_CONTENT_INSET * 2;
  const tagWidth = Math.ceil(Math.max(TAG_MIN_WIDTH, headerWidth, contentWidth));
  const previousBodyPadding = (TAG_BODY_HEIGHT - 42 - visibleTextHeight(baseShowMetrics)) / 2;
  const previousLineGap = 42 - visibleTextHeight(baseProducerMetrics);
  const lineOffset = visibleTextHeight(producerMetrics) + previousLineGap;
  const bodyHeight = previousBodyPadding * 2 + lineOffset + visibleTextHeight(showMetrics);
  const footerTextHeight = visibleTextHeight(footerMetrics);
  const footerHeight = TAG_DIVIDER_HEIGHT + TAG_PADDING + footerTextHeight + TAG_PADDING + TAG_BORDER;
  const tagHeight = headerHeight + bodyHeight + footerHeight;
  const tagX = ARTWORK_SIZE - TAG_EDGE_OFFSET - tagWidth;
  const tagY = ARTWORK_SIZE - TAG_EDGE_OFFSET - tagHeight;
  const headerDividerY = tagY + headerHeight - TAG_DIVIDER_HEIGHT;
  const footerDividerY = tagY + headerHeight + bodyHeight;

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
    tagY + (headerHeight - TAG_DIVIDER_HEIGHT - LOGO_HEIGHT) / 2,
    LOGO_WIDTH,
    LOGO_HEIGHT,
  );

  const cityX = tagX + tagWidth - TAG_CONTENT_INSET - cityWidth;
  const cityY = tagY + (headerHeight - TAG_DIVIDER_HEIGHT - cityHeight) / 2;
  context.fillRect(cityX, cityY, cityWidth, cityHeight);
  context.fillStyle = theme.background;
  context.font = `500 ${CITY_FONT_SIZE}px "Favoritpro", Arial, sans-serif`;
  context.textAlign = "center";
  const cityBaseline = cityY + (cityHeight - visibleTextHeight(cityMetrics)) / 2 + cityMetrics.actualBoundingBoxAscent;
  context.fillText(city, cityX + cityWidth / 2, cityBaseline);

  context.fillStyle = theme.foreground;
  context.textAlign = "left";
  context.font = `500 ${MAIN_FONT_SIZE}px "Favoritpro", Arial, sans-serif`;
  const bodyTop = headerDividerY + TAG_DIVIDER_HEIGHT;
  const producerTop = bodyTop + previousBodyPadding;
  context.fillText(producerName, tagX + TAG_CONTENT_INSET, visibleTextBaseline(producerTop, producerMetrics));
  const showTop = producerTop + lineOffset;
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

    drawCoverCrop(context, sourceImage, ARTWORK_SIZE, ARTWORK_SIZE);
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

const STORY_TAG_BOTTOM_SAFE_AREA = 228;
const STORY_TAG_MIN_WIDTH = 632;
const STORY_TAG_HEADER_HEIGHT = 84;
const STORY_LOGO_WIDTH = 248;
const STORY_LOGO_HEIGHT = 60;
const STORY_MAIN_FONT_SIZE = 64;
const STORY_META_FONT_SIZE = 40;
const STORY_CITY_HEIGHT = 52;
const STORY_BODY_VERTICAL_PADDING = 16;

function drawStoryEpisodeTag(
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
  context.font = `500 ${STORY_MAIN_FONT_SIZE}px "Favoritpro", Arial, sans-serif`;
  const producerMetrics = context.measureText(producerName);
  const showMetrics = context.measureText(radioShow);
  context.font = `500 ${STORY_META_FONT_SIZE}px "Favoritpro", Arial, sans-serif`;
  const cityMetrics = context.measureText(city);
  const footerMetrics = context.measureText(footer);

  const cityWidth = Math.ceil(cityMetrics.width + TAG_PADDING * 2);
  const headerWidth = TAG_CONTENT_INSET + STORY_LOGO_WIDTH + 24 + cityWidth + TAG_CONTENT_INSET;
  const contentWidth = Math.max(producerMetrics.width, showMetrics.width, footerMetrics.width)
    + TAG_CONTENT_INSET * 2;
  const tagWidth = Math.ceil(Math.max(STORY_TAG_MIN_WIDTH, headerWidth, contentWidth));
  const storyLineOffset = 76;
  const bodyHeight = STORY_BODY_VERTICAL_PADDING + storyLineOffset
    + visibleTextHeight(showMetrics) + STORY_BODY_VERTICAL_PADDING;
  const footerHeight = TAG_DIVIDER_HEIGHT + TAG_PADDING
    + visibleTextHeight(footerMetrics) + TAG_PADDING + TAG_BORDER;
  const tagHeight = STORY_TAG_HEADER_HEIGHT + bodyHeight + footerHeight;
  const tagX = Math.round((STORY_ARTWORK_WIDTH - tagWidth) / 2);
  const tagY = STORY_ARTWORK_HEIGHT - STORY_TAG_BOTTOM_SAFE_AREA - tagHeight;
  const headerDividerY = tagY + STORY_TAG_HEADER_HEIGHT - TAG_DIVIDER_HEIGHT;
  const footerDividerY = tagY + STORY_TAG_HEADER_HEIGHT + bodyHeight;

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
    tagY + (STORY_TAG_HEADER_HEIGHT - TAG_DIVIDER_HEIGHT - STORY_LOGO_HEIGHT) / 2,
    STORY_LOGO_WIDTH,
    STORY_LOGO_HEIGHT,
  );

  const cityX = tagX + tagWidth - TAG_CONTENT_INSET - cityWidth;
  const cityY = tagY + (STORY_TAG_HEADER_HEIGHT - TAG_DIVIDER_HEIGHT - STORY_CITY_HEIGHT) / 2;
  context.fillRect(cityX, cityY, cityWidth, STORY_CITY_HEIGHT);
  context.fillStyle = theme.background;
  context.font = `500 ${STORY_META_FONT_SIZE}px "Favoritpro", Arial, sans-serif`;
  context.textAlign = "center";
  const cityBaseline = cityY + (STORY_CITY_HEIGHT - visibleTextHeight(cityMetrics)) / 2
    + cityMetrics.actualBoundingBoxAscent;
  context.fillText(city, cityX + cityWidth / 2, cityBaseline);

  context.fillStyle = theme.foreground;
  context.textAlign = "left";
  context.font = `500 ${STORY_MAIN_FONT_SIZE}px "Favoritpro", Arial, sans-serif`;
  const bodyTop = headerDividerY + TAG_DIVIDER_HEIGHT;
  const producerTop = bodyTop + STORY_BODY_VERTICAL_PADDING;
  context.fillText(producerName, tagX + TAG_CONTENT_INSET, visibleTextBaseline(producerTop, producerMetrics));
  const showTop = producerTop + storyLineOffset;
  context.fillText(radioShow, tagX + TAG_CONTENT_INSET, visibleTextBaseline(showTop, showMetrics));

  const footerTop = footerDividerY + TAG_DIVIDER_HEIGHT + TAG_PADDING;
  context.font = `500 ${STORY_META_FONT_SIZE}px "Favoritpro", Arial, sans-serif`;
  context.fillText(footer, tagX + TAG_CONTENT_INSET, visibleTextBaseline(footerTop, footerMetrics));
}

export async function createShowStoryArtwork(
  sourceFile: Blob,
  details: ShowArtworkDetails,
  themeName: ArtworkThemeName,
) {
  const theme = ARTWORK_THEMES.find((candidate) => candidate.name === themeName) ?? ARTWORK_THEMES[0];
  const sourceUrl = URL.createObjectURL(sourceFile);
  try {
    const [sourceImage, logo] = await Promise.all([
      loadBrowserImage(sourceUrl),
      loadBrowserImage(theme.logoPath),
      document.fonts.load(`500 ${STORY_MAIN_FONT_SIZE}px "Favoritpro"`),
      document.fonts.load(`500 ${STORY_META_FONT_SIZE}px "Favoritpro"`),
    ]);
    const canvas = document.createElement("canvas");
    canvas.width = STORY_ARTWORK_WIDTH;
    canvas.height = STORY_ARTWORK_HEIGHT;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Story artwork generation is not supported by this browser.");

    drawCoverCrop(context, sourceImage, STORY_ARTWORK_WIDTH, STORY_ARTWORK_HEIGHT);
    drawStoryEpisodeTag(context, logo, theme, details);

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (result) => result ? resolve(result) : reject(new Error("The story artwork could not be exported.")),
        "image/jpeg",
        0.94,
      );
    });
    const safeTitle = details.radioShow.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "show";
    return new File([blob], `${safeTitle}-story.jpg`, { type: "image/jpeg" });
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}
