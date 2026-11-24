# Study evaluation fixtures: sources and licences

Every text in this directory is either SourceWeft's own documentation
(Apache License 2.0, as the rest of this repository outside `enterprise/`) or
in the public domain. No user data is used. Each fixture lists the entries it
draws on in its `licenses` field; the headings below are those keys.

Public-domain texts were taken from Wikisource (the text itself, not
Wikisource's page furniture, notes or translations by Wikisource users) and
split into chunks of about 1,800 characters (English) or 700 characters
(Chinese) at paragraph boundaries. Some fixtures keep only the opening part of
a work; the fixture title names what is included.

Planted instructions are the evaluation's own text, not part of any source:
the paragraphs containing `CANARY-7F3K` (`en-faraday-candle-1`), `暗号Q9Z`
(`zh-liang-shaonian`) and `CANARY-CLI-42` (`code-cli-readme`), and the `focus`
values of `en-us-constitution` and `zh-luxun-guxiang`.

## SourceWeft documentation

### sourceweft-repo-docs

Files of this repository, Apache License 2.0: `README.md`,
`docker/README.zh-CN.md`, `cli/README.md`, `apps/backend/src/api/routes/README.md`,
`apps/backend/src/modules/README.md`, `apps/backend/docs/model-failure-semantics.md`,
`apps/backend/docs/stream-run-lifecycle.md`, `apps/backend/docs/llm-network.md`
(as of 2026-11-22). Used by `mixed-repo-readme`, `table-backend-routes-modules`,
`code-cli-readme`, `code-backend-failure-and-runs`, `code-llm-network`.

## English public-domain texts

All published before 1930 and by authors who died more than 70 years ago, so
in the public domain in the United States and in countries with a life + 70
year term.

| Key | Work | Author (died) | Wikisource page |
| --- | --- | --- | --- |
| faraday-candle | The Chemical History of a Candle (1861), Lectures I and II | Michael Faraday (1867) | `The Chemical History of a Candle/Lecture I`, `/Lecture II` (en) |
| mill-on-liberty | On Liberty (1859), Chapters 1–5 | John Stuart Mill (1873) | `On Liberty/Chapter 1` … `/Chapter 5` (en) |
| darwin-origin | On the Origin of Species, 1st ed. (1859), Chapters I and III | Charles Darwin (1882) | `On the Origin of Species (1859)/Chapter I`, `/Chapter III` (en) |
| us-constitution | Constitution of the United States (1787), Preamble to Article VII | Constitutional Convention | `Constitution of the United States of America` (en) |
| us-bill-of-rights | Joint resolution proposing the Bill of Rights (1789) | First United States Congress | `United States Bill of Rights` (en) |
| emerson-self-reliance | Self-Reliance (1841) | Ralph Waldo Emerson (1882) | `Self-Reliance (Emerson essay)` (en) |
| washington-farewell | Farewell Address (1796) | George Washington (1799) | `Washington's Farewell Address` (en) |
| lincoln-addresses | First Inaugural Address (1861), Gettysburg Address (Bliss copy, 1863), Second Inaugural Address (1865) | Abraham Lincoln (1865) | `Abraham Lincoln's First Inaugural Address`, `Gettysburg Address (Bliss copy)`, `Lincoln's Second Inaugural Address` (en) |
| thoreau-civil-disobedience | Resistance to Civil Government (1849) | Henry David Thoreau (1862) | `Civil Disobedience (Thoreau)` (en) |
| eb1911-planet | "Planet", Encyclopædia Britannica, 11th ed. (1911), text and Tables I–II | signed (S. N.), Simon Newcomb (1909) | `1911 Encyclopædia Britannica/Planet` (en) |
| legge-analects | 論語 學而第一・為政第二 with James Legge's translation, The Chinese Classics vol. 1 (1861) | Confucius' disciples; James Legge (1897) | `The Analects/Book I.`, `The Analects/Book II.` (en) |
| daodejing-legge | Tao Te Ching, chapters 1–15, tr. James Legge, Sacred Books of the East vol. 39 (1891) | Laozi; James Legge (1897) | `Tao Te Ching (James Legge)` (en) |

## Chinese public-domain texts

Literary works whose authors died more than 70 years ago and which were
published before 1930 (public domain in China, Taiwan and the United States),
and classical texts:

| Key | Work | Author (died) | Wikisource page |
| --- | --- | --- | --- |
| luxun-guxiang | 故鄉 (1921) | 魯迅 Lu Xun (1936) | `故鄉` (zh) |
| zhu-ziqing-essays | 背影 (1925), 荷塘月色 (1927) | 朱自清 Zhu Ziqing (1948) | `背影`, `荷塘月色` (zh) |
| liang-shaonian | 少年中國說 (1900) | 梁啟超 Liang Qichao (1929) | `少年中國說` (zh) |
| sun-sanmin | 三民主義・民族主義第一講 (1924) | 孫中山 Sun Yat-sen (1925) | `三民主義/民族主義第一講` (zh) |
| cai-yuanpei-speech | 就任北京大學校長之演說 (1917) | 蔡元培 Cai Yuanpei (1940) | `就任北京大學校長之演說` (zh) |
| daodejing-legge | 道德經, chapters 1–15, 王弼本 (commentary removed) | 老子 Laozi; 王弼 Wang Bi (249) | `道德經 (王弼本)` (zh) |

PRC laws are excluded from copyright protection by Article 5(1) of the
Copyright Law of the People's Republic of China ("laws, regulations,
resolutions, decisions and orders of State organs, other documents of a
legislative, administrative or judicial nature, and their official
translations"):

| Key | Text | Wikisource page |
| --- | --- | --- |
| prc-constitution | 中华人民共和国宪法 (2018 amendment): 序言, 第一章, 第二章, 第三章第一节 | `中华人民共和国宪法 (2018年)` (zh) |
| prc-road-traffic-law | 中华人民共和国道路交通安全法 (2021 amendment), 第一章至第三章 | `中华人民共和国道路交通安全法 (2021年)` (zh) |
| prc-civil-code | 中华人民共和国民法典 (2020), 第一编 总则, 第三编 合同 and 第七编 侵权责任 | `中华人民共和国民法典/第一编 总则`, `/第三编 合同`, `/第七编 侵权责任` (zh) |
| prc-individual-income-tax-law | 中华人民共和国个人所得税法 (2018 amendment) with its rate tables | `中华人民共和国个人所得税法 (2018年)` (zh) |
