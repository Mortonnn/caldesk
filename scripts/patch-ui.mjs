/**
 * 一轮 UI 补丁：自定义重复、侧栏遮罩、删除重复任务确认
 * 运行： node scripts/patch-ui.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'src/renderer/src/App.tsx'
let t = readFileSync(file, 'utf8')
const applied = []

function rep(label, from, to) {
  if (!t.includes(from)) {
    console.error(`✗ 未找到片段: ${label}`)
    return
  }
  t = t.replace(from, to)
  applied.push(label)
}

// 1) 预设类型加上 custom
rep(
  'RepeatPreset 类型',
  "type RepeatPreset = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly'",
  "type RepeatPreset = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'custom'"
)

// 2) 文案
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

// 3) 状态
rep(
  'state',
  "  const [syncing, setSyncing] = useState(false)",
  `  const [syncing, setSyncing] = useState(false)
  const [customRrule, setCustomRrule] = useState('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO')
  const [confirmDelete, setConfirmDelete] = useState<EventOccurrence | null>(null)`
)

// 4) ruleFromPreset 支持 custom
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

// 5) 删除事件改为走确认流程
rep(
  'delete onClick',
  'onClick={() => void removeEvent(occ.event.id)}',
  'onClick={() => void requestRemoveEvent(occ)}'
)

// 6) 新增 requestRemoveEvent / skipOne
rep(
  'requestRemoveEvent',
  `  async function removeEvent(id: string): Promise<void> {`,
  `  /** 重复任务先问「只删本次 / 删整个重复」 */
  async function requestRemoveEvent(occ: EventOccurrence): Promise<void> {
    if (!occ.event.rrule) {
      await removeEvent(occ.event.id)
      return
    }
    setConfirmDelete(occ)
  }

  async function skipOne(): Promise<void> {
    if (!confirmDelete || !activeCal) return
    const res = await data.events.skip(confirmDelete.event.id, confirmDelete.date)
    if (!res.ok) {
      setEventError(res.error)
      return
    }
    setConfirmDelete(null)
    await loadRange(activeCal)
  }

  async function removeEvent(id: string): Promise<void> {`
)

// 7) 自定义 RRULE 输入框
rep(
  'custom rrule input',
  `                      ))}
                    </select>
                  </div>
                </div>`,
  `                      ))}
                    </select>
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

// 8) 侧栏面板遮罩（点空白关闭）
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

// 9) 关闭补上 </>
rep(
  'panel scrim close',
  `              {panelError && <p className="cal-error">{panelError}</p>}
            </motion.aside>
          )}
        </AnimatePresence>`,
  `              {panelError && <p className="cal-error">{panelError}</p>}
            </motion.aside>
            </>
          )}
        </AnimatePresence>`
)

// 10) 删除确认弹窗
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
                仅删除 {confirmDelete.date.slice(5)} 这一天
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
console.log(`已应用 ${applied.length} 处: ${applied.join(' / ')}`)
