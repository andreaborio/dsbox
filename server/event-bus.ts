import { EventEmitter } from "node:events";
import type { ServerEvent } from "../src/types.js";

export class EventBus extends EventEmitter {
  publish(event: ServerEvent): void {
    this.emit("event", event);
  }
}

