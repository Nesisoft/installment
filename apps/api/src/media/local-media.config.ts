/**
 * What `MediaController` needs to serve the local driver's URLs.
 *
 * A class rather than an interface so Nest can use it as an injection token
 * without a string constant.
 */
export class LocalMediaConfig {
  constructor(
    /**
     * False unless STORAGE_DRIVER=local. The controller is mounted either way —
     * a conditional `controllers` array reads `process.env` behind the config
     * module's back — so it refuses every request when the driver that mints
     * its URLs is not the one running.
     */
    readonly enabled: boolean,
    readonly directory: string,
    readonly secret: string,
    readonly maxUploadBytes: number,
  ) {}
}
