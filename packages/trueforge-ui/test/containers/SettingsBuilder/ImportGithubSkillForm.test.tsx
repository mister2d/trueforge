// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import ImportGithubSkillForm from '@/containers/SettingsBuilder/ImportGithubSkillForm.js';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
});

describe('ImportGithubSkillForm', () => {
  it('submits the complete create skill request', async () => {
    const onImport = vi.fn(async () => undefined);

    render(<ImportGithubSkillForm open onOpenChange={() => undefined} onImport={onImport} />);

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: ' Release notes ' },
    });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: ' Generate release notes ' },
    });
    fireEvent.change(screen.getByLabelText('Repository URL'), {
      target: { value: ' https://github.com/org/repo ' },
    });
    fireEvent.change(screen.getByLabelText('Folder containing the SKILL.md'), {
      target: { value: ' skills/release-notes ' },
    });
    fireEvent.change(screen.getByLabelText('Branch'), {
      target: { value: ' main ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() => {
      expect(onImport).toHaveBeenCalledWith({
        name: 'Release notes',
        description: 'Generate release notes',
        repoURL: 'https://github.com/org/repo',
        path: 'skills/release-notes',
        ref: 'main',
      });
    });
  });

  it('allows importing a skill at repository root with blank folder and default branch', async () => {
    const onImport = vi.fn(async () => undefined);

    render(<ImportGithubSkillForm open onOpenChange={() => undefined} onImport={onImport} />);

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Root Skill' },
    });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Skill at repo root' },
    });
    fireEvent.change(screen.getByLabelText('Repository URL'), {
      target: { value: 'https://github.com/org/repo' },
    });
    // Leave Folder containing the SKILL.md and Branch empty
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() => {
      expect(onImport).toHaveBeenCalledWith({
        name: 'Root Skill',
        description: 'Skill at repo root',
        repoURL: 'https://github.com/org/repo',
        path: '',
        ref: 'main',
      });
    });
  });

  it('normalizes dot and slash paths to root', async () => {
    const onImport = vi.fn(async () => undefined);

    render(<ImportGithubSkillForm open onOpenChange={() => undefined} onImport={onImport} />);

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Dot Skill' },
    });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Skill with dot path' },
    });
    fireEvent.change(screen.getByLabelText('Repository URL'), {
      target: { value: 'https://github.com/org/repo' },
    });
    fireEvent.change(screen.getByLabelText('Folder containing the SKILL.md'), {
      target: { value: ' . ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() => {
      expect(onImport).toHaveBeenCalledWith({
        name: 'Dot Skill',
        description: 'Skill with dot path',
        repoURL: 'https://github.com/org/repo',
        path: '',
        ref: 'main',
      });
    });
  });
});
