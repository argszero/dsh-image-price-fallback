/**
 * The estimate itself, as a pure function of an image occurrence.
 *
 * ## Why a dimension estimate and not a measured tokenizer
 *
 * `LlmImageRequestPricing.priceImages()` must answer **synchronously and
 * without I/O** — the token meter resolves it on every measurement. A real
 * tokenizer for an unknown gateway model therefore cannot be called. What is
 * available synchronously is the durable reference, and it carries the
 * normalized `width` and `height` of the attachment, which is exactly the input
 * every published vision accounting is built from.
 *
 * The three constants below are one published rate each, named with its
 * provenance rather than invented here:
 *
 * - `divisor` 750 — pixels per visual token (Anthropic's published rate).
 * - `minTokens` 85 — the base cost a small image never falls below (OpenAI's
 *   low-detail accounting).
 * - `maxTokens` 1600 — the ceiling one image reaches (a single image stops
 *   costing more past this point in the published tables).
 *
 * The point of the fallback is not to be exact — an exact number is impossible
 * without the provider's tokenizer. It is to stop pricing a retained image at
 * the JSON length of its reference, which is what the meter does when a route
 * declares no pricing: a few dozen tokens against a real charge of a thousand
 * or more. The estimate is a **floor in the right order of magnitude**, and
 * every constant is a configuration knob.
 *
 * ## What is deliberately not estimated
 *
 * An occurrence the surface marks `offloaded` is not sent as pixels at all: the
 * runtime replaces it with a placeholder through `projectOffloadedImages()`,
 * which is why the DeepSeek adapter prices it `visualTokens: 0`. The same
 * applies here, and the placeholder text is taken from the harness's own
 * `offloadedImageText()` rather than re-spelled, so the text half of the price
 * cannot drift from the text the request actually carries.
 *
 * A retained occurrence is priced as pixels **plus no text**: the model sees the
 * image, not a handle. The DeepSeek adapter adds `requestImageHandleText()` here
 * because its serializer ships a handle line beside the image; no such line is
 * known to exist on an unknown gateway route, and inventing one would be
 * quoting text the model never reads.
 *
 * @module @argszero/dsh-image-price-fallback/estimate
 */

import { offloadedImageText } from '@deepseek-ai/dsh-llm'
import type { ImageBlock, LlmImageRequestPrice, LlmImageRequestPricing } from '@deepseek-ai/dsh-llm'

/** The three published constants one estimate is built from. */
export interface VisualPricing {
  /** Pixels per estimated visual token. */
  readonly divisor: number
  /** Lowest estimate charged for one retained image. */
  readonly minTokens: number
  /** Highest estimate charged for one retained image. */
  readonly maxTokens: number
}

/**
 * Estimate the visual tokens one retained image costs its route.
 *
 * A reference without usable dimensions is charged {@link VisualPricing.minTokens}:
 * an unmeasurable image is still an image, and pricing it at zero would recreate
 * the understatement this plugin exists to remove. The result is clamped at both
 * ends, so the estimate is bounded by configuration alone.
 * @param ref - the occurrence's durable normalized attachment.
 * @param pricing - the resolved constants.
 * @returns the visual-token estimate, between `minTokens` and `maxTokens`.
 */
export function estimateVisualTokens(
  ref: Pick<ImageBlock['attachment'], 'width' | 'height'>,
  pricing: VisualPricing,
): number {
  const { width, height } = ref
  if (!(typeof width === 'number' && Number.isFinite(width) && width > 0)
    || !(typeof height === 'number' && Number.isFinite(height) && height > 0)) {
    return pricing.minTokens
  }
  const raw = Math.ceil((width * height) / pricing.divisor)
  if (!Number.isFinite(raw)) return pricing.maxTokens
  return Math.min(pricing.maxTokens, Math.max(pricing.minTokens, raw))
}

/**
 * Price one surface's image occurrences, one price per occurrence, in order.
 *
 * The count and the order are a contract: the token meter throws when a route
 * prices a different number of occurrences than it was asked about, precisely
 * because a misalignment would silently misprice every node after it. A
 * one-to-one `map` is the only shape that cannot violate it.
 * @param images - surface image blocks in request order.
 * @param pricing - the resolved constants.
 * @returns one price per occurrence, aligned by index.
 */
export function priceOccurrences(
  images: readonly ImageBlock[],
  pricing: VisualPricing,
): readonly LlmImageRequestPrice[] {
  return images.map((block) => {
    if (block.offloaded === true) {
      return { visualTokens: 0, text: offloadedImageText(block.attachment) }
    }
    return { visualTokens: estimateVisualTokens(block.attachment, pricing), text: '' }
  })
}

/**
 * The `LlmImageRequestPricing` implementation a priced route receives.
 * @param pricing - the resolved constants.
 * @returns the pricing object, bound to nothing and safe to share.
 */
export function createRoutePricing(pricing: VisualPricing): LlmImageRequestPricing {
  return {
    priceImages: images => priceOccurrences(images, pricing),
  }
}

/**
 * Describe the estimate in one line, for a log or a diagnostic.
 * @param pricing - the resolved constants.
 * @returns the formula as written.
 */
export function describePricing(pricing: VisualPricing): string {
  return `ceil(width * height / ${pricing.divisor}) clamped to ${pricing.minTokens}..${pricing.maxTokens}`
}
