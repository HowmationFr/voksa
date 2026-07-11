import React from 'react';

type Props = {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
};

export function Toggle({ checked, onChange, disabled }: Props): React.ReactElement {
  return (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className="toggle-switch"
      data-on={checked ? 'true' : 'false'}
    />
  );
}
