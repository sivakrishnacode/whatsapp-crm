import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { DropdownMenuGroup, DropdownMenuLabel } from './dropdown-menu'

/**
 * Regression for issue #336 — "clicking Add node reloads the page".
 *
 * DropdownMenuLabel is base-ui's Menu.GroupLabel, which reads a required
 * Menu.Group context and THROWS at render when it's missing. The flow
 * builder's add-node menu wrapped its labels in a plain <div> instead of
 * a DropdownMenuGroup, so opening the menu crashed the whole page. These
 * tests pin the contract so the div-wrapper regression can't come back.
 */
describe('DropdownMenuLabel requires a DropdownMenuGroup ancestor', () => {
  it('throws when rendered without a group (the #336 crash)', () => {
    expect(() =>
      renderToStaticMarkup(
        React.createElement(DropdownMenuLabel, null, 'Messaging'),
      ),
    ).toThrow()
  })

  it('renders when wrapped in a DropdownMenuGroup (the fix)', () => {
    expect(() =>
      renderToStaticMarkup(
        React.createElement(
          DropdownMenuGroup,
          null,
          React.createElement(DropdownMenuLabel, null, 'Messaging'),
        ),
      ),
    ).not.toThrow()
  })
})


/**
 * ⚠️ AND THE SAME CHECK ACROSS EVERY CALL SITE.
 *
 * The two tests above pin the PRIMITIVE's contract, which is necessary and was
 * not sufficient: the contract held, the comment warning about it sat in two
 * other components, and the workspace switcher still shipped a bare
 * DropdownMenuLabel. Opening it threw Base UI error #31 and the page died —
 * the same crash as #336, in a new file, past a green test suite.
 *
 * A component test per menu would not have caught it either; nobody writes one
 * for a menu they believe is trivial. So this walks the source instead: any
 * file that renders a label must also render a group.
 *
 * It is a heuristic — it checks presence, not nesting, so a file with one
 * correct group and one stray label elsewhere would pass. It costs nothing and
 * catches the mistake people actually make, which is forgetting the group
 * entirely.
 */
describe('every DropdownMenuLabel call site has a DropdownMenuGroup', () => {
  const SRC = path.join(process.cwd(), 'src')

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, out)
      else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) {
        out.push(full)
      }
    }
    return out
  }

  it('has no file rendering a label without a group', () => {
    const offenders = walk(SRC)
      .filter((file) => {
        const src = fs.readFileSync(file, 'utf8')
        // The primitive's own definition is where both live by construction.
        if (file.endsWith(path.join('ui', 'dropdown-menu.tsx'))) return false
        return src.includes('<DropdownMenuLabel') && !src.includes('<DropdownMenuGroup')
      })
      .map((file) => path.relative(process.cwd(), file))

    expect(offenders).toEqual([])
  })
})
