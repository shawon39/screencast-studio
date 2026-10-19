/** An error whose message and hint are written for the person using the app. */
export class UserError extends Error {
  hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.hint = hint;
  }
}
