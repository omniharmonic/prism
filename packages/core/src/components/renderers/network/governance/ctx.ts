// The small bundle of state + actions every governance component needs. Passed
// explicitly as a prop (no React context) so each component's dependencies stay
// visible in its signature and the panel remains trivially testable.
import type { ApiResult, GovState, Membership, MyAccess } from "./api";
import type { TagCount } from "../../../../lib/types";

export interface GovCtx {
  state: GovState;
  /** Who is looking — used to decide whose proposal may be withdrawn. */
  me: MyAccess | null;
  /** The full roster (who holds which role). */
  members: Membership[];
  /** Vault tags, for the scope pickers. Empty when /api/tags is not readable. */
  tags: TagCount[];
  /** Known account emails for the member datalist; empty when /acl/users 403s. */
  users: string[];
  /** True while the constitution may still be written directly (pre-lock owner). */
  direct: boolean;
  /** Run a write, surface its error in the panel, then refresh everything. */
  run: <T>(fn: () => Promise<ApiResult<T>>) => Promise<ApiResult<T>>;
  /** Open a pre-filled `amend_governance` proposal carrying this change. */
  amend: (change: Record<string, unknown>, label: string) => Promise<ApiResult>;
  /** Show a transient confirmation line at the top of the panel. */
  notify: (message: string) => void;
}

/** Did a write fail because the constitution is locked and needs an amendment? */
export const needsProposal = (r: ApiResult): boolean =>
  r.status === 403 && (r.data as { error?: string } | null)?.error === "requires_proposal";
