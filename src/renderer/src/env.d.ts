import type { DevelopmentApi } from "../../shared/runtime";

declare global {
  interface Window {
    development: DevelopmentApi;
  }
}
