import userEvent from '@testing-library/user-event';
export function setup() {
  return { user: userEvent.setup() };
}
