export const IMAGE_SHARING_MESSAGE = "Image sharing by link is unavailable. Download the .excalidraw file to preserve images, then open it in Excalidraw.";

export function hasLiveImages(elements: readonly { type: string; isDeleted?: boolean }[]): boolean {
  return elements.some((element) => element.type === "image" && !element.isDeleted);
}
