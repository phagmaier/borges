import type { BorgesApi, DevelopmentApi } from "../../shared/runtime";

declare global {
  interface Window {
    development: DevelopmentApi;
    borges: BorgesApi;
  }
}
