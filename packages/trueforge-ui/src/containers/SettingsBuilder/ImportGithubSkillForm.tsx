'use client';

import { useState, type SyntheticEvent } from 'react';

import { auiInputClass } from '@/atoms/lib/inputClasses.js';
import { Button } from '@/atoms/primitives/Button.js';
import { CenteredModal } from '@/atoms/primitives/CenteredModal.js';
import { Icon } from '@/icons/Icon.js';
import type { SkillConfigBase } from '../../server/types.js';

type ImportGithubSkillFormProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImport: (draft: SkillConfigBase) => void | Promise<void>;
  busy?: boolean;
  error?: string | null;
};

const ImportGithubSkillForm = ({ open, onOpenChange, onImport, busy = false, error }: ImportGithubSkillFormProps) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [repoURL, setRepoURL] = useState('');
  const [path, setPath] = useState('');
  const [ref, setRef] = useState('');

  const reset = () => {
    setName('');
    setDescription('');
    setRepoURL('');
    setPath('');
    setRef('');
  };

  const close = () => {
    reset();
    onOpenChange(false);
  };

  const handleSubmit = async (event: SyntheticEvent<HTMLFormElement, SubmitEvent>) => {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedDescription = description.trim();
    const trimmedRepoURL = repoURL.trim();
    const trimmedPath = path.trim();
    const trimmedRef = ref.trim() || 'main';

    if (!trimmedName || !trimmedDescription || !trimmedRepoURL || busy) return;

    const normalizedPath =
      trimmedPath === '.' || trimmedPath === '/' || trimmedPath === './'
        ? ''
        : trimmedPath.replace(/^\.?\/+/, '').replace(/\/+$/, '');

    try {
      await onImport({
        name: trimmedName,
        description: trimmedDescription,
        repoURL: trimmedRepoURL,
        path: normalizedPath,
        ref: trimmedRef,
      });
      close();
    } catch {
      // Parent surfaces error; keep form open.
    }
  };

  const canImport = Boolean(name.trim() && description.trim() && repoURL.trim()) && !busy;

  return (
    <CenteredModal
      open={open}
      onOpenChange={nextOpen => {
        if (!nextOpen) close();
      }}
      title="Import from GitHub"
      description="Import a skill from a SKILL.md file in a GitHub repository."
      headerIcon={
        <span className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary-bg text-text-primary">
          <Icon name="github" className="size-5" />
        </span>
      }
      contentSized
      className="md:max-w-2xl"
    >
      <form onSubmit={e => void handleSubmit(e)}>
        <div className="space-y-5 px-5 py-5 md:px-6">
          <div>
            <label htmlFor="skill-name" className="mb-2 block text-sm font-semibold text-text-primary">
              Name
            </label>
            <input
              id="skill-name"
              value={name}
              onChange={event => {
                setName(event.target.value);
              }}
              placeholder="release-notes"
              autoFocus
              required
              className={auiInputClass('h-11')}
            />
          </div>

          <div>
            <label htmlFor="skill-description" className="mb-2 block text-sm font-semibold text-text-primary">
              Description
            </label>
            <textarea
              id="skill-description"
              value={description}
              onChange={event => {
                setDescription(event.target.value);
              }}
              placeholder="Generate release notes from merged pull requests"
              required
              rows={3}
              className={auiInputClass('resize-y py-2.5')}
            />
          </div>

          <div>
            <label htmlFor="skill-repo-url" className="mb-2 block text-sm font-semibold text-text-primary">
              Repository URL
            </label>
            <input
              id="skill-repo-url"
              type="url"
              value={repoURL}
              onChange={event => {
                setRepoURL(event.target.value);
              }}
              placeholder="https://github.com/org/repo"
              required
              className={auiInputClass('h-11')}
            />
          </div>

          <div>
            <label htmlFor="skill-path" className="mb-2 block text-sm font-semibold text-text-primary">
              Folder containing the SKILL.md
            </label>
            <input
              id="skill-path"
              value={path}
              onChange={event => {
                setPath(event.target.value);
              }}
              placeholder="skills/release-notes (leave blank if at repository root)"
              className={auiInputClass('h-11')}
            />
            <p className="mt-1.5 text-xs text-text-secondary">
              Optional. Subfolder path within the repository. Leave blank if SKILL.md is at the repository root.
            </p>
          </div>

          <div>
            <label htmlFor="skill-ref" className="mb-2 block text-sm font-semibold text-text-primary">
              Branch
            </label>
            <input
              id="skill-ref"
              value={ref}
              onChange={event => {
                setRef(event.target.value);
              }}
              placeholder="main"
              className={auiInputClass('h-11')}
            />
            <p className="mt-1.5 text-xs text-text-secondary">
              Optional. Git branch, tag, or commit SHA. Defaults to main.
            </p>
          </div>

          <div className="space-y-3">
            {error ? <p className="text-failure-bg text-sm">{error}</p> : null}
            <Button.Primary type="submit" disabled={!canImport} className="w-full">
              Import
            </Button.Primary>
          </div>
        </div>
      </form>
    </CenteredModal>
  );
};

export default ImportGithubSkillForm;
