/** Product publication state machine (SRS §11.3). */
export type ProductStatus = 'draft' | 'published' | 'unpublished' | 'suspended' | 'archived';

const ALLOWED: Record<ProductStatus, ProductStatus[]> = {
  draft: ['published', 'archived'],
  published: ['unpublished', 'suspended'],
  unpublished: ['published', 'archived'],
  suspended: ['published'],
  archived: []
};

export function canProductTransition(from: ProductStatus, to: ProductStatus): boolean {
  return (ALLOWED[from] ?? []).includes(to);
}

/** Unpublished/suspended products shall not be orderable (FR-CAT-11, BR-08). */
export function isOrderable(status: ProductStatus): boolean {
  return status === 'published';
}
