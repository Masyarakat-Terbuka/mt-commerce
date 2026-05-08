/**
 * Plugin error types.
 *
 * Two narrow error classes the channel raises:
 *
 *   - `UnsupportedKindError` — the operator did not configure a template
 *     name for this kind. The channel cannot guess; the service surfaces
 *     this as a `failed` audit row with a clear message.
 *
 *   - `ChannelDispatchError` — the upstream WhatsApp Cloud API rejected
 *     the request (non-2xx). The Meta error body is preserved on
 *     `details` so an operator can grep `WhatsAppError code=132001` from
 *     pino's structured field rather than reassembling the response.
 *
 * Both extend `Error` directly so they survive an instanceof check across
 * module boundaries even when bundlers duplicate the class identity. A
 * structural `name`-string check is the safer guard for cross-package
 * callers; we set `name` explicitly for that reason.
 */

export class UnsupportedKindError extends Error {
  constructor(public readonly kind: string) {
    super(
      `WhatsApp channel: no template configured for kind "${kind}". ` +
        `Add it to the plugin's \`templates\` option.`,
    );
    this.name = "UnsupportedKindError";
  }
}

/**
 * Wraps a non-2xx response from Meta's WhatsApp Cloud API.
 *
 * `status` is the HTTP status. `details` is the parsed JSON body if Meta
 * returned one, otherwise the raw text — Meta's error envelope is
 * documented as `{ error: { message, type, code, error_subcode, ... } }`
 * but operators occasionally see HTML 502s from the edge layer.
 */
export class ChannelDispatchError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly details: unknown,
  ) {
    super(message);
    this.name = "ChannelDispatchError";
  }
}
