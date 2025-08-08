import type { ProposalType } from "../domain/intent";
import {
  validateProposals,
  type ValidationResult,
} from "../services/proposalValidator";

export type { ValidationResult };

export async function validateEdit(
  edit: ProposalType
): Promise<ValidationResult> {
  const arr = await validateProposals([edit]);
  return (
    arr[0] ?? {
      isValid: true,
      errors: [],
      warnings: ["Validator returned no result"],
    }
  );
}

export async function validateEdits(
  edits: ProposalType[]
): Promise<ValidationResult[]> {
  return validateProposals(edits);
}
