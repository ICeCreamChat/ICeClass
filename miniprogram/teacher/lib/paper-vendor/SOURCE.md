These two MIT-licensed files are copied without changes from
`web_controller/card-quiz/vendor/{aruco,cv}.js` in this repository. Their
copyright and license notices remain in each file. No package or network
dependency is added. The native adapter uses `QCMCAM_4X4_157h3`, the same
157-card dictionary and orientation/stabilization rules as the existing scanner.

The camera adapter consumes native RGBA frames in memory. It does not upload,
record or persist camera frames. Only stabilized card numbers and answer
letters enter the authenticated, paired classroom command API.
