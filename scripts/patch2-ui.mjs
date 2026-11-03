/** 剩余 UI 补丁（幂等）。运行： node scripts/patch2-ui.mjs */
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'src/renderer/src/App.tsx'
let t = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
const done = []

function rep(label, from, to) {
  if (t.includes(to)) {
    done.push(`${label}(已存在)`)
    return true
  }
  if (!t.includes(from)) {
    console.error(`✗ 未找到: ${label}`)
    return false
  }
  t = t.replace(from, to)
  done.push(label)
  return true
}

rep(
  'REPEAT_LABEL',
  `  monthly: '每月',
  yearly: '每年'
}`,
  `  monthly: '每月',
  yearly: '每年',
  custom: '自定义…'
}`
)

rep(
  'ruleFromPreset',
  `      case 'yearly':
        return 'FREQ=YEARLY'
      default:
        return null`,
  `      case 'yearly':
        return 'FREQ=YEARLY'
      case 'custom':
        return customRrule.trim() || null
      default:
        return null`
)

rep(
  'custom rrule input',
  `                    </select>
                  </div>
                </div>`,
  `                    </select>
                  </div>
                  {eventRepeat === 'custom' && (
                    <input
                      className="task-input"
                      value={customRrule}
                      placeholder="RRULE，如 FREQ=WEEKLY;INTERVAL=2;BYDAY=MO"
                      onChange={(e) => setCustomRrule(e.target.value)}
                    />
                  )}
                </div>`
)

rep(
  'panel scrim',
  `          {panel !== 'none' && (
            <motion.aside
              className="panel"`,
  `          {panel !== 'none' && (
            <>
              <div
                className="panel-scrim"
                onClick={() => {
                  setPanel('none')
                  setEditing(null)
                }}
              />
              <motion.aside
                className="panel"`
)

rep(
  'panel scrim close',
  `              {panelError && <p className="cal-error">{panelError}</p>}
            </motion.aside>
          )}`,
  `              {panelError && <p className="cal-error">{panelError}</p>}
              </motion.aside>
            </>
          )}`
)

rep(
  'confirm dialog',
  `      </div>
    </div>
  )
}`,
  `      </div>

      {confirmDelete && (
        <div className="confirm-backdrop" onClick={() => setConfirmDelete(null)}>
          <div className="confirm-card" onClick={(e) => e.stopPropagation()}>
            <h3>删除重复任务</h3>
            <p>「{confirmDelete.event.title}」是重复任务，要删除哪一部分？</p>
            <div className="confirm-actions">
              <button className="ghost" onClick={() => setConfirmDelete(null)}>
                取消
              </button>
              <button className="ghost" onClick={() => void skipOne()}>
                仅删除 {confirmDelete.date.slice(5)} 这天
              </button>
              <button
                className="primary-btn"
                onClick={() => {
                  void removeEvent(confirmDelete.event.id)
                  setConfirmDelete(null)
                }}
              >
                删除整个重复
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}`
)

writeFileSync(file, t, 'utf8')
console.log('结果: ' + done.join(' / '))
