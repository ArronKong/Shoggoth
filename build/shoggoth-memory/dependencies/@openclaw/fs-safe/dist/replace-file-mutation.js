import { assertSynchronousCallbackResult } from "./mutation-authority.js";
export class AtomicMutation {
    active;
    #assertion;
    #observer;
    #refusal;
    #writingReported = false;
    constructor(options) {
        this.#assertion = options.assertBeforeMutation;
        this.#observer = options.onDestinationState;
        this.active = Boolean(this.#assertion || this.#observer);
    }
    rethrowRefusal() {
        if (this.#refusal)
            throw this.#refusal.error;
    }
    refuse(error) {
        this.#refusal ??= { error };
        throw this.#refusal.error;
    }
    #invoke(operation, name) {
        this.rethrowRefusal();
        try {
            const result = operation();
            assertSynchronousCallbackResult(result, name);
        }
        catch (error) {
            this.refuse(error);
        }
    }
    assert() {
        this.#invoke(() => this.#assertion?.(), "assertBeforeMutation");
    }
    destination(state, path, identity) {
        if (state === "writing") {
            if (this.#writingReported)
                return;
            this.#writingReported = true;
        }
        this.#invoke(() => this.#observer?.(Object.freeze({
            state, path, dev: identity.dev, ino: identity.ino,
        })), "onDestinationState");
    }
    removed(path) {
        this.#invoke(() => this.#observer?.(Object.freeze({ state: "removed", path })), "onDestinationState");
    }
}
