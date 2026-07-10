/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
declare module 'credential-handler-polyfill' {
  export function load(mediator: string): Promise<void>
  export function loadOnce(mediator: string): Promise<void>
  export class WebCredential {
    constructor(
      dataType: string,
      data: object,
      options?: { recommendedHandlerOrigins?: string[] }
    )
  }
}
