# 第三方说明

ICeClass · 班伴由 ICeCreamChat 在原 ICeCreamShouter 通知平台基础上扩展。

本文汇总项目使用的第三方组件与素材及其许可。应用自身代码的使用范围以仓库根目录 `LICENSE` 中的“非商业学习参考许可”为准。

## 早读陪伴

早读陪伴由项目所有者提供并授权集成。原网页自带的字体、笔画数据、图标、Three.js 许可文本保留在 `web_controller/reading/index.html` 的 `third-party-licenses` 数据块中，同时提取到 `docs/licenses/` 便于查阅。

早读素材随原应用提供并保留；第三方字体、笔画数据和图标分别遵循各自许可，不受应用自身许可变更的影响。

## Microsoft Edge WebView2

教室端早读页面与教师端网页工作台使用 Microsoft.Web.WebView2 SDK 1.0.3650.58。Microsoft Corporation 版权所有。完整 SDK 许可和第三方声明保留在 `docs/licenses/WebView2-LICENSE.txt` 与 `docs/licenses/WebView2-NOTICE.txt`，并嵌入两端 EXE，可在“关于 ICeClass 班伴”查看。Microsoft Edge WebView2 Evergreen Runtime 由 Microsoft 单独提供，遵循其运行时许可。

## Lucide icons

教室首页使用 lucide-static 0.468.0 的 book-open 与 mic 原始图标，以原始矢量路径离线呈现。

- 项目网站：<https://lucide.dev>
- 项目仓库：<https://github.com/lucide-icons/lucide>
- 许可证：ISC；其中源自 Feather 的图标遵循下述 MIT 许可。

```text
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

---

The following Lucide icons are derived from the Feather project:

airplay, alert-circle, alert-octagon, alert-triangle, aperture, arrow-down-circle, arrow-down-left, arrow-down-right, arrow-down, arrow-left-circle, arrow-left, arrow-right-circle, arrow-right, arrow-up-circle, arrow-up-left, arrow-up-right, arrow-up, at-sign, calendar, cast, check, chevron-down, chevron-left, chevron-right, chevron-up, chevrons-down, chevrons-left, chevrons-right, chevrons-up, circle, clipboard, clock, code, columns, command, compass, corner-down-left, corner-down-right, corner-left-down, corner-left-up, corner-right-down, corner-right-up, corner-up-left, corner-up-right, crosshair, database, divide-circle, divide-square, dollar-sign, download, external-link, feather, frown, hash, headphones, help-circle, info, italic, key, layout, life-buoy, link-2, link, loader, lock, log-in, log-out, maximize, meh, minimize, minimize-2, minus-circle, minus-square, minus, monitor, moon, more-horizontal, more-vertical, move, music, navigation-2, navigation, octagon, pause-circle, percent, plus-circle, plus-square, plus, power, radio, rss, search, server, share, shopping-bag, sidebar, smartphone, smile, square, table-2, tablet, target, terminal, trash-2, trash, triangle, tv, type, upload, x-circle, x-octagon, x-square, x, zoom-in, zoom-out

The MIT License (MIT) (for the icons listed above)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 其他依赖

### System.Speech

Windows 教室端的普通通知使用 System.Speech 8.0.0 连接本机语音合成组件。班班对话的识别和播报使用下述 sherpa-onnx 与 MeloTTS 本地模型。Windows 语音组件由 Microsoft 提供，系统语音包不随本项目分发。System.Speech 的 MIT 许可如下：

```text
The MIT License (MIT)

Copyright (c) .NET Foundation and Contributors

All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

其他第三方依赖遵循各自软件包附带的许可证。本说明不改变第三方组件的版权归属及许可条件，也不改变 ICeCreamChat 对项目自身代码所享有的权利。

### sherpa-onnx 与本地语音模型

Windows 教室端使用 sherpa-onnx 2.0.0（The Next-gen Kaldi development team / Xiaomi Corporation）和 wenetspeech 3.3M 关键词模型（2024-01-01，epoch-12/avg-2 的量化 encoder、decoder、joiner 与 tokens），用于本机唤醒和带名字的停止口令。引擎及模型声明为 Apache-2.0。模型来源与文件校验值随源码保存在 Receiver/Assets/Voice/manifest.json；录音不随模型保存或上传。

整句识别使用 Alibaba Group / FunAudioLLM 的 SenseVoiceSmall，经 csukuangfj 转换为 sherpa-onnx INT8。转换仓库固定到提交 `2365baeacb507f821a0c8120fcee3d484dba7a07`，分发 `model.int8.onnx` 和 `tokens.txt`，未修改模型权重。模型采用独立的 FunASR Model Open Source License Agreement 1.1，非下方的引擎 Apache-2.0 许可；完整模型协议见本说明末尾及 `SenseVoice-MODEL-LICENSE.txt`。下载来源和文件 SHA-256 保存在 `Receiver/Assets/Voice/Asr/manifest.json`，可使用 `scripts/prepare-banban-asr.py` 重建。

对话中的说话人比对使用 Alibaba Group / ModelScope 3D-Speaker 的 CAM++ 中英模型，由 sherpa-onnx 提供 ONNX 转换与本地运行接口。分发的 `3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx` 重命名为 `speaker.onnx`，未修改权重，遵循 Apache-2.0；完整许可见下方及 `3D-Speaker-LICENSE.txt`。来源和 SHA-256 保存在 `Receiver/Assets/Voice/Speaker/manifest.json`，重建脚本为 `scripts/prepare-banban-speaker.py`。当前对话的说话人特征仅保存在内存中，不作为身份认证凭据，不保存为用户声纹档案。

Apache-2.0 许可全文：

```text

                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.

```

### ONNX Runtime

随 sherpa-onnx Windows 运行时分发 ONNX Runtime 1.28.2，由 Microsoft Corporation 提供，采用 MIT 许可：

```text
MIT License

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

```


### MeloTTS 中文音色

班班的离线中文神经合成使用 MyShell.ai 的 MeloTTS Chinese-English 模型（MIT），经 sherpa-onnx 运行。模型源文件固定到维护者仓库提交 `a0d5c6a264c0ef92d70d8661d8cc502d79627cd6`，构建时校验 SHA-256；未修改模型权重。

```text
Copyright (c) 2024 MyShell.ai

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Silero VAD

播报期间的本地语音活动检测使用 Silero VAD v5（MIT）。

```text
MIT License

Copyright (c) 2020-present Silero Team

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 小智设计参考

班班的会话状态、分句播报、回声处理和打断清理参考了 MIT 许可的 `78/xiaozhi-esp32`、`huangjunsen0406/py-xiaozhi`、`xinnan-tech/xiaozhi-esp32-server`。此次为针对现有 Windows 任务引擎的独立适配，未打包这些项目的代码或程序。版本与源码对照见项目文档《班班与小智源码对照》。

### SenseVoiceSmall 模型协议

FunASR Model Open Source License Agreement

Version: 1.1

Copyright (C) [2023-2028] [Alibaba Group]. All rights reserved.

Thank you for choosing the FunASR open-source model. The FunASR open-source model includes a range of free and open industrial models for you to use, modify, share, and learn from.

To ensure better community collaboration, we have established the following agreement, and we hope you will read and comply with its terms.
Definitions

In this agreement, [FunASR Software] refers to FunASR open-source model weights and their derivatives, including finetuned models; [You] refers to individuals or organizations using, modifying, sharing, and learning from [FunASR Software].

2 License and Restrictions

2.1 License

You are free to use, copy, modify, and share [FunASR Software] under the terms of this agreement.

2.2 Restrictions

When using, copying, modifying, and sharing [FunASR Software], you must attribute the source and author information and retain relevant model names in [FunASR Software].

3 Responsibility and Risk

[FunASR Software] is provided for reference and learning purposes only, and Alibaba Group assumes no responsibility for any direct or indirect losses resulting from your use or modification of [FunASR Software]. You should assume all risks associated with using and modifying [FunASR Software].

4 Community Conduct Guidelines

4.1 Encouraged Behavior

The community welcomes developers and users to engage in discussions about [FunASR Software]. Participants are encouraged to interact in a friendly, polite, and respectful manner to foster constructive discussion and collaboration.

4.2 Prohibited Behavior

Individual or organizational users shall not engage in unjustified denigration, malicious smearing, or baseless insults against [FunASR Software]. Such behavior is considered a violation of the spirit of community cooperation. If a user is found to be engaging in the prohibited behavior mentioned above, it will be considered an automatic forfeiture of all licenses under this agreement.

5 Termination

If you violate any terms of this agreement, your license will automatically terminate, and you must cease using, copying, modifying, and sharing [FunASR Software].

6 Revisions

This agreement may be updated and revised occasionally. The revised agreement will be published in the official repository of [FunASR Software] and will take effect automatically. Continuing to use, copy, modify, and share [FunASR Software] indicates your acceptance of the revised agreement.

7 Miscellaneous

This agreement is governed by the laws of [Country/Region]. If any provision is deemed illegal, invalid, or unenforceable, that provision shall be considered severed from this agreement, and the remaining provisions shall continue to be valid and binding.

If you have any questions or comments regarding this agreement, please contact us.

Copyright © [2023-2028] [Alibaba Group]. All rights reserved.


FunASR 模型开源协议

版本号：1.1

版权所有 (C) [2023-2028] [阿里巴巴集团]。保留所有权利。

感谢您选择 FunASR 开源模型。FunASR 开源模型包含一系列免费且开源的工业模型，让大家可以使用、修改、分享和学习该模型。

为了保证更好的社区合作，我们制定了以下协议，希望您仔细阅读并遵守本协议。

1 定义

本协议中，[FunASR 软件]指 FunASR 开源模型权重及其衍生品，包括 Finetune 后的模型；[您]指使用、修改、分享和学习[FunASR 软件]的个人或组织。

2 许可和限制

2.1 许可

您可以在遵守本协议的前提下，自由地使用、复制、修改和分享[FunASR 软件]。

2.2 限制

您在使用、复制、修改和分享[FunASR 软件]时，必须注明出处以及作者信息，并保留[FunASR 软件]中相关模型名称。

3 责任和风险承担

[FunASR 软件]仅作为参考和学习使用，不对您使用或修改[FunASR 软件]造成的任何直接或间接损失承担任何责任。您对[FunASR 软件]的使用和修改应该自行承担风险。

4 社区行为准则

4.1 欢迎交流

社区欢迎开发者与用户对[FunASR 软件]进行交流讨论。交流中请注意保持友好、礼貌和文明，以促进建设性的讨论和合作。

4.2 禁止行为

个人或组织用户不得对[FunASR 软件]进行无端诋毁、恶意抹黑或凭空谩骂。此类行为被视为违反社区合作精神。如被认定从事上述禁止行为，将视为自动放弃本协议下的所有许可。

5 终止

如果您违反本协议的任何条款，您的许可将自动终止，您必须停止使用、复制、修改和分享[FunASR 软件]。

6 修订

本协议可能会不时更新和修订。修订后的协议将在[FunASR 软件]官方仓库发布，并自动生效。如果您继续使用、复制、修改和分享[FunASR 软件]，即表示您同意修订后的协议。

7 其他规定

本协议受到[国家/地区] 的法律管辖。如果任何条款被裁定为不合法、无效或无法执行，则该条款应被视为从本协议中删除，而其余条款应继续有效并具有约束力。

如果您对本协议有任何问题或意见，请联系我们。

版权所有© [2023-2028] [阿里巴巴集团]。保留所有权利。

