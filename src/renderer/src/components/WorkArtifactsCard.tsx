// WorkArtifactsCard: 工作模式产物汇总卡（Codex 风格 Changes）
//
// 形状（按用户要求收简过）：
//   · 折叠头：产物数量 + 总增减统计 + 整卡展开/收起，默认展开；
//   · 每个文件一行：图标 + 路径 +N -M，**点文件名直接打开预览**（与工作区面板同一口径）。
//     此前每行右侧另有一颗「预览」按钮和一颗展开行级改动的箭头，三个控件挤在一行、
//     且两个入口做同一件事；现在行上只留文件名这一个入口。
//
// 为什么值得一张卡：一轮工作跑完，用户最想知道的就是「这轮产出了/改了哪些文件、各加了多少行」。
// 数据来自已移植但此前零引用的 core/common/WorkArtifacts（由主进程汇总后下发），
// 桌面端在此之前只能去工作区列表里自己找。
import { useState } from 'react'
import type { ArtifactFileDto, WorkArtifactsDto } from '@ipc/contract'
import { IconChevronDown, IconFile } from '../icons'

interface Props {
  artifacts: WorkArtifactsDto
  /** 点文件名时打开内容（复用工作区的预览弹层） */
  onPreview(path: string): void
}

export function WorkArtifactsCard({ artifacts, onPreview }: Props) {
  const [expanded, setExpanded] = useState(true)

  if (artifacts.files.length === 0) {
    return null
  }

  return (
    <div className="artifacts">
      <button className="artifacts__head" onClick={() => setExpanded((v) => !v)}>
        <span className="artifacts__icon">
          <IconFile size={16} />
        </span>
        <span className="artifacts__title">
          <strong>产物</strong>
          <small>
            {`${artifacts.files.length} 个文件 · `}
            <span className="diff-stat__add">+{artifacts.totalAdds}</span>{' '}
            <span className="diff-stat__del">-{artifacts.totalDels}</span>
          </small>
        </span>
        <span className="artifacts__caret" data-open={expanded}>
          <IconChevronDown size={13} />
        </span>
      </button>

      {expanded ? (
        <div className="artifacts__list">
          {artifacts.files.map((file) => (
            <ArtifactFileRow key={file.path} file={file} onPreview={() => onPreview(file.path)} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function ArtifactFileRow({ file, onPreview }: { file: ArtifactFileDto; onPreview(): void }) {
  return (
    <div className="artifact">
      <div className="artifact__row">
        <button
          className="artifact__path"
          title={`${file.path}\n点击预览`}
          onClick={onPreview}
        >
          <IconFile size={14} />
          <span className="artifact__name">{file.path}</span>
        </button>
        {file.adds > 0 || file.dels > 0 ? (
          <span className="artifact__counts">
            <span className="diff-stat__add">+{file.adds}</span>{' '}
            <span className="diff-stat__del">-{file.dels}</span>
          </span>
        ) : null}
      </div>
    </div>
  )
}
