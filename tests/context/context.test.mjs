import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import {
  HierarchyValidationError,
  assembleContextPacket,
  validateHierarchy,
} from '../../src/context/index.ts';

function requirement(id, text = id) {
  return { id, text, revision: `${id}@r1` };
}

function node(id, kind, label, parentId) {
  return {
    id,
    kind,
    label,
    ...(parentId ? { parentId } : {}),
    objective: requirement(`${id}-objective`, `${id} objective`),
    criteria: [requirement(`${id}-criterion`, `${id} criterion`)],
    designReferences: [{ ...requirement(`${id}-design`, `${id} approved design`), approved: true }],
    artifacts: [requirement(`${id}-artifact`, `${id} artifact revision`)],
    commands: [{ command: `npm test -- ${id}`, revision: `${id}-command@r1` }],
    authority: [requirement(`${id}-authority`, `${id} authority`)],
    evidenceRequirements: [requirement(`${id}-evidence`, `${id} evidence`)],
  };
}

function hierarchy() {
  const product = node('product', 'planning', 'Product');
  product.constraints = [requirement('product-constraint', 'Preserve public API compatibility')];
  const feature = node('feature', 'planning', 'Feature', 'product');
  feature.constraints = [requirement('feature-constraint', 'Keep changes within the billing module')];
  const bug = node('small-bug', 'executable', 'Fix invoice rounding', 'feature');
  bug.constraints = [{ ...requirement('bug-refinement', 'Only change the rounding helper'), refinesConstraintId: 'feature-constraint' }];
  const unrelatedSibling = node('unrelated-sibling', 'executable', 'Rebuild reports', 'feature');
  const apiContract = node('billing-contract', 'planning', 'Billing contract', 'feature');

  return {
    revision: 'hierarchy@r9',
    globalConstraints: [requirement('global-security', 'Do not expose credentials')],
    nodes: [product, feature, bug, unrelatedSibling, apiContract],
    dependencies: [
      {
        id: 'bug-needs-billing-contract',
        fromId: 'small-bug',
        toId: 'billing-contract',
        contract: requirement('rounding-contract', 'Use currencyMinorUnits from the billing contract'),
      },
    ],
  };
}

describe('hierarchy and scoped context packets', () => {
  it('preserves planning and executable types even when labels are identical', () => {
    const document = hierarchy();
    document.nodes[1].label = 'Billing work';
    document.nodes[2].label = 'Billing work';

    const resolved = validateHierarchy(document);

    expect(resolved.nodes.find((item) => item.id === 'feature')).toEqual(expect.objectContaining({ kind: 'planning' }));
    expect(resolved.nodes.find((item) => item.id === 'small-bug')).toEqual(expect.objectContaining({ kind: 'executable' }));
  });

  it('assembles a small-bug packet with global and ancestor constraints but no unrelated sibling content', () => {
    const packet = assembleContextPacket(hierarchy(), 'small-bug');
    const serialized = JSON.stringify(packet);

    expect(packet.node).toEqual(expect.objectContaining({ id: 'small-bug', kind: 'executable' }));
    expect(packet.constraints.global).toEqual([expect.objectContaining({ id: 'global-security', sourceRevision: 'global-security@r1' })]);
    expect(packet.constraints.ancestors.map((constraint) => constraint.id)).toEqual(['product-constraint', 'feature-constraint']);
    expect(packet.constraints.local).toEqual([expect.objectContaining({ id: 'bug-refinement', refinesConstraintId: 'feature-constraint' })]);
    expect(packet.dependencyContracts).toEqual([
      expect.objectContaining({ id: 'bug-needs-billing-contract', contract: expect.objectContaining({ id: 'rounding-contract' }) }),
    ]);
    expect(packet.objective).toEqual(expect.objectContaining({ sourceRevision: 'small-bug-objective@r1' }));
    expect(packet.designReferences).toContainEqual(expect.objectContaining({ sourceRevision: 'small-bug-design@r1' }));
    expect(packet.artifacts).toContainEqual(expect.objectContaining({ id: 'product-artifact', sourceNodeId: 'product', sourceRevision: 'product-artifact@r1' }));
    expect(packet.commands).toContainEqual(expect.objectContaining({ command: 'npm test -- product', sourceNodeId: 'product', sourceRevision: 'product-command@r1' }));
    expect(packet.authority).toContainEqual(expect.objectContaining({ id: 'product-authority', sourceNodeId: 'product', sourceRevision: 'product-authority@r1' }));
    expect(packet.evidenceRequirements).toContainEqual(expect.objectContaining({ id: 'product-evidence', sourceNodeId: 'product', sourceRevision: 'product-evidence@r1' }));
    expect(serialized).not.toContain('Rebuild reports');
    expect(serialized).not.toContain('unrelated-sibling');
  });

  it('includes a sibling only through its explicit dependency contract, not its full context', () => {
    const packet = assembleContextPacket(hierarchy(), 'small-bug');
    const serialized = JSON.stringify(packet);

    expect(serialized).toContain('Use currencyMinorUnits from the billing contract');
    expect(serialized).not.toContain('billing-contract objective');
  });

  it('rejects a child that attempts to redefine an accepted ancestor constraint', () => {
    const document = hierarchy();
    document.nodes[2].constraints = [requirement('feature-constraint', 'Use a different module boundary')];

    expect(() => validateHierarchy(document)).toThrow(/nodes\[2\]\.constraints\[0\]\.id: cannot redefine accepted ancestor constraint "feature-constraint"/);
  });

  it('allows an additive refinement while retaining the ancestor constraint unchanged', () => {
    const packet = assembleContextPacket(hierarchy(), 'small-bug');

    expect(packet.constraints.ancestors).toContainEqual(expect.objectContaining({ text: 'Keep changes within the billing module' }));
    expect(packet.constraints.local).toContainEqual(expect.objectContaining({ refinesConstraintId: 'feature-constraint' }));
  });

  it('rejects parent cycles with the node path that closes the cycle', () => {
    const document = hierarchy();
    document.nodes[0].parentId = 'small-bug';

    expect(() => validateHierarchy(document)).toThrow(/nodes\[0\]\.parentId: introduces a parent cycle product -> small-bug -> feature -> product/);
  });

  it('rejects dependency cycles', () => {
    const document = hierarchy();
    document.dependencies.push({
      id: 'contract-needs-bug',
      fromId: 'billing-contract',
      toId: 'small-bug',
      contract: requirement('reverse-contract', 'Wait for the bug result'),
    });

    expect(() => validateHierarchy(document)).toThrow(/dependencies\[1\]\.toId: introduces a dependency cycle billing-contract -> small-bug -> billing-contract/);
  });

  it('reports missing references at the relationship path', () => {
    const document = hierarchy();
    document.dependencies[0].toId = 'missing-contract';

    expect(() => validateHierarchy(document)).toThrow(/dependencies\[0\]\.toId: unknown node "missing-contract"/);
  });

  it('rejects an unapproved design reference before it reaches a packet', () => {
    const document = hierarchy();
    document.nodes[2].designReferences[0].approved = false;

    expect(() => assembleContextPacket(document, 'small-bug')).toThrow(/nodes\[2\]\.designReferences\[0\]\.approved: must be true; unapproved design references cannot enter a context packet/);
  });

  it('loads the documented hierarchy example', async () => {
    const example = JSON.parse(await readFile(new URL('../../examples/context/small-bug.json', import.meta.url), 'utf8'));

    const packet = assembleContextPacket(example, 'rounding-bug');

    expect(packet.node.kind).toBe('executable');
    expect(packet.constraints.ancestors.map((constraint) => constraint.id)).toContain('billing-boundary');
  });

  it('exposes structured validation issues to callers', () => {
    try {
      validateHierarchy({});
      throw new Error('expected hierarchy validation failure');
    } catch (error) {
      expect(error).toBeInstanceOf(HierarchyValidationError);
      expect(error.issues[0]).toEqual(expect.objectContaining({ path: 'revision' }));
    }
  });
});
