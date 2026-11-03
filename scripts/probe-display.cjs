// 临时诊断脚本：打印显示器与缩放信息后退出
const { app, screen } = require('electron')

app.whenReady().then(() => {
  for (const d of screen.getAllDisplays()) {
    console.log(
      JSON.stringify(
        {
          id: d.id,
          label: d.label,
          bounds: d.bounds,
          workArea: d.workArea,
          scaleFactor: d.scaleFactor,
          primary: d.id === screen.getPrimaryDisplay().id
        },
        null,
        2
      )
    )
  }
  app.quit()
})
