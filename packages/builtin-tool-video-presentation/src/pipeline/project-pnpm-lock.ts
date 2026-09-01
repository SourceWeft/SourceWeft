/**
 * Fully resolved dependency graph for the generated trusted render project.
 * Regenerate deliberately whenever the renderer or React pins change.
 */
export const VIDEO_PRESENTATION_PNPM_LOCK = String.raw`lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      '@remotion/bundler':
        specifier: 4.0.468
        version: 4.0.468(postcss@8.5.26)(react-dom@18.3.1(react@18.3.1))(react@18.3.1)
      '@remotion/renderer':
        specifier: 4.0.468
        version: 4.0.468(react-dom@18.3.1(react@18.3.1))(react@18.3.1)
      react:
        specifier: 18.3.1
        version: 18.3.1
      react-dom:
        specifier: 18.3.1
        version: 18.3.1(react@18.3.1)
      remotion:
        specifier: 4.0.468
        version: 4.0.468(react-dom@18.3.1(react@18.3.1))(react@18.3.1)
    devDependencies:
      '@types/react':
        specifier: 18.3.18
        version: 18.3.18
      '@types/react-dom':
        specifier: 18.3.5
        version: 18.3.5(@types/react@18.3.18)
      typescript:
        specifier: 5.9.2
        version: 5.9.2

packages:

  '@emnapi/core@1.11.3':
    resolution: {integrity: sha512-zLpS5asjEb7lq8jYLq37N6XKaE41DIexlY1rF/z4/tIl3wo13Sqm28fRyfIsKZD+NZ8mM5RoKkpW/rBcuoSZSg==}

  '@emnapi/runtime@1.11.3':
    resolution: {integrity: sha512-Xz4Tpyki7XyrpbUK1jR1AhdAdaXyhhY4lZ3neLodmhpuWfy2PAQN5B46sAiU4liOXGLkHypn/qU+jvfWSCYYLA==}

  '@emnapi/wasi-threads@1.2.3':
    resolution: {integrity: sha512-ELEBe8PsLvvJ6QMr0zLt8ffvOHW/dc1m3CEzNMg7aJUv3bMaoDtw2TXyDAwkYBuroxxuHEwhRTLJSe5sya547g==}

  '@esbuild/aix-ppc64@0.28.0':
    resolution: {integrity: sha512-lhRUCeuOyJQURhTxl4WkpFTjIsbDayJHih5kZC1giwE+MhIzAb7mEsQMqMf18rHLsrb5qI1tafG20mLxEWcWlA==}
    engines: {node: '>=18'}
    cpu: [ppc64]
    os: [aix]

  '@esbuild/android-arm64@0.28.0':
    resolution: {integrity: sha512-+WzIXQOSaGs33tLEgYPYe/yQHf0WTU0X42Jca3y8NWMbUVhp7rUnw+vAsRC/QiDrdD31IszMrZy+qwPOPjd+rw==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [android]

  '@esbuild/android-arm@0.28.0':
    resolution: {integrity: sha512-wqh0ByljabXLKHeWXYLqoJ5jKC4XBaw6Hk08OfMrCRd2nP2ZQ5eleDZC41XHyCNgktBGYMbqnrJKq/K/lzPMSQ==}
    engines: {node: '>=18'}
    cpu: [arm]
    os: [android]

  '@esbuild/android-x64@0.28.0':
    resolution: {integrity: sha512-+VJggoaKhk2VNNqVL7f6S189UzShHC/mR9EE8rDdSkdpN0KflSwWY/gWjDrNxxisg8Fp1ZCD9jLMo4m0OUfeUA==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [android]

  '@esbuild/darwin-arm64@0.28.0':
    resolution: {integrity: sha512-0T+A9WZm+bZ84nZBtk1ckYsOvyA3x7e2Acj1KdVfV4/2tdG4fzUp91YHx+GArWLtwqp77pBXVCPn2We7Letr0Q==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [darwin]

  '@esbuild/darwin-x64@0.28.0':
    resolution: {integrity: sha512-fyzLm/DLDl/84OCfp2f/XQ4flmORsjU7VKt8HLjvIXChJoFFOIL6pLJPH4Yhd1n1gGFF9mPwtlN5Wf82DZs+LQ==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [darwin]

  '@esbuild/freebsd-arm64@0.28.0':
    resolution: {integrity: sha512-l9GeW5UZBT9k9brBYI+0WDffcRxgHQD8ShN2Ur4xWq/NFzUKm3k5lsH4PdaRgb2w7mI9u61nr2gI2mLI27Nh3Q==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [freebsd]

  '@esbuild/freebsd-x64@0.28.0':
    resolution: {integrity: sha512-BXoQai/A0wPO6Es3yFJ7APCiKGc1tdAEOgeTNy3SsB491S3aHn4S4r3e976eUnPdU+NbdtmBuLncYir2tMU9Nw==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [freebsd]

  '@esbuild/linux-arm64@0.28.0':
    resolution: {integrity: sha512-RVyzfb3FWsGA55n6WY0MEIEPURL1FcbhFE6BffZEMEekfCzCIMtB5yyDcFnVbTnwk+CLAgTujmV/Lgvih56W+A==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [linux]

  '@esbuild/linux-arm@0.28.0':
    resolution: {integrity: sha512-CjaaREJagqJp7iTaNQjjidaNbCKYcd4IDkzbwwxtSvjI7NZm79qiHc8HqciMddQ6CKvJT6aBd8lO9kN/ZudLlw==}
    engines: {node: '>=18'}
    cpu: [arm]
    os: [linux]

  '@esbuild/linux-ia32@0.28.0':
    resolution: {integrity: sha512-KBnSTt1kxl9x70q+ydterVdl+Cn0H18ngRMRCEQfrbqdUuntQQ0LoMZv47uB97NljZFzY6HcfqEZ2SAyIUTQBQ==}
    engines: {node: '>=18'}
    cpu: [ia32]
    os: [linux]

  '@esbuild/linux-loong64@0.28.0':
    resolution: {integrity: sha512-zpSlUce1mnxzgBADvxKXX5sl8aYQHo2ezvMNI8I0lbblJtp8V4odlm3Yzlj7gPyt3T8ReksE6bK+pT3WD+aJRg==}
    engines: {node: '>=18'}
    cpu: [loong64]
    os: [linux]

  '@esbuild/linux-mips64el@0.28.0':
    resolution: {integrity: sha512-2jIfP6mmjkdmeTlsX/9vmdmhBmKADrWqN7zcdtHIeNSCH1SqIoNI63cYsjQR8J+wGa4Y5izRcSHSm8K3QWmk3w==}
    engines: {node: '>=18'}
    cpu: [mips64el]
    os: [linux]

  '@esbuild/linux-ppc64@0.28.0':
    resolution: {integrity: sha512-bc0FE9wWeC0WBm49IQMPSPILRocGTQt3j5KPCA8os6VprfuJ7KD+5PzESSrJ6GmPIPJK965ZJHTUlSA6GNYEhg==}
    engines: {node: '>=18'}
    cpu: [ppc64]
    os: [linux]

  '@esbuild/linux-riscv64@0.28.0':
    resolution: {integrity: sha512-SQPZOwoTTT/HXFXQJG/vBX8sOFagGqvZyXcgLA3NhIqcBv1BJU1d46c0rGcrij2B56Z2rNiSLaZOYW5cUk7yLQ==}
    engines: {node: '>=18'}
    cpu: [riscv64]
    os: [linux]

  '@esbuild/linux-s390x@0.28.0':
    resolution: {integrity: sha512-SCfR0HN8CEEjnYnySJTd2cw0k9OHB/YFzt5zgJEwa+wL/T/raGWYMBqwDNAC6dqFKmJYZoQBRfHjgwLHGSrn3Q==}
    engines: {node: '>=18'}
    cpu: [s390x]
    os: [linux]

  '@esbuild/linux-x64@0.28.0':
    resolution: {integrity: sha512-us0dSb9iFxIi8srnpl931Nvs65it/Jd2a2K3qs7fz2WfGPHqzfzZTfec7oxZJRNPXPnNYZtanmRc4AL/JwVzHQ==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [linux]

  '@esbuild/netbsd-arm64@0.28.0':
    resolution: {integrity: sha512-CR/RYotgtCKwtftMwJlUU7xCVNg3lMYZ0RzTmAHSfLCXw3NtZtNpswLEj/Kkf6kEL3Gw+BpOekRX0BYCtklhUw==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [netbsd]

  '@esbuild/netbsd-x64@0.28.0':
    resolution: {integrity: sha512-nU1yhmYutL+fQ71Kxnhg8uEOdC0pwEW9entHykTgEbna2pw2dkbFSMeqjjyHZoCmt8SBkOSvV+yNmm94aUrrqw==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [netbsd]

  '@esbuild/openbsd-arm64@0.28.0':
    resolution: {integrity: sha512-cXb5vApOsRsxsEl4mcZ1XY3D4DzcoMxR/nnc4IyqYs0rTI8ZKmW6kyyg+11Z8yvgMfAEldKzP7AdP64HnSC/6g==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [openbsd]

  '@esbuild/openbsd-x64@0.28.0':
    resolution: {integrity: sha512-8wZM2qqtv9UP3mzy7HiGYNH/zjTA355mpeuA+859TyR+e+Tc08IHYpLJuMsfpDJwoLo1ikIJI8jC3GFjnRClzA==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [openbsd]

  '@esbuild/openharmony-arm64@0.28.0':
    resolution: {integrity: sha512-FLGfyizszcef5C3YtoyQDACyg95+dndv79i2EekILBofh5wpCa1KuBqOWKrEHZg3zrL3t5ouE5jgr94vA+Wb2w==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [openharmony]

  '@esbuild/sunos-x64@0.28.0':
    resolution: {integrity: sha512-1ZgjUoEdHZZl/YlV76TSCz9Hqj9h9YmMGAgAPYd+q4SicWNX3G5GCyx9uhQWSLcbvPW8Ni7lj4gDa1T40akdlw==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [sunos]

  '@esbuild/win32-arm64@0.28.0':
    resolution: {integrity: sha512-Q9StnDmQ/enxnpxCCLSg0oo4+34B9TdXpuyPeTedN/6+iXBJ4J+zwfQI28u/Jl40nOYAxGoNi7mFP40RUtkmUA==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [win32]

  '@esbuild/win32-ia32@0.28.0':
    resolution: {integrity: sha512-zF3ag/gfiCe6U2iczcRzSYJKH1DCI+ByzSENHlM2FcDbEeo5Zd2C86Aq0tKUYAJJ1obRP84ymxIAksZUcdztHA==}
    engines: {node: '>=18'}
    cpu: [ia32]
    os: [win32]

  '@esbuild/win32-x64@0.28.0':
    resolution: {integrity: sha512-pEl1bO9mfAmIC+tW5btTmrKaujg3zGtUmWNdCw/xs70FBjwAL3o9OEKNHvNmnyylD6ubxUERiEhdsL0xBQ9efw==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [win32]

  '@jridgewell/gen-mapping@0.3.13':
    resolution: {integrity: sha512-2kkt/7niJ6MgEPxF0bYdQ6etZaA+fQvDcLKckhy1yIQOzaoKjBBjSj63/aLVjYE3qhRt5dvM+uUyfCg6UKCBbA==}

  '@jridgewell/resolve-uri@3.1.2':
    resolution: {integrity: sha512-bRISgCIjP20/tbWSPWMEi54QVPRZExkuD9lJL+UIxUKtwVJA8wW1Trb1jMs1RFXo1CBTNZ/5hpC9QvmKWdopKw==}
    engines: {node: '>=6.0.0'}

  '@jridgewell/source-map@0.3.11':
    resolution: {integrity: sha512-ZMp1V8ZFcPG5dIWnQLr3NSI1MiCU7UETdS/A0G8V/XWHvJv3ZsFqutJn1Y5RPmAPX6F3BiE397OqveU/9NCuIA==}

  '@jridgewell/sourcemap-codec@1.6.0':
    resolution: {integrity: sha512-T7jf+5zgsZHwNJ4lvQ7/aezbyk0nNX+zJVWpmHA7VYsEx7a7qr5Rg5IbtJFqkgze5Y2sruq1RUY8Q837Od7iFw==}

  '@jridgewell/trace-mapping@0.3.31':
    resolution: {integrity: sha512-zzNR+SdQSDJzc8joaeP8QQoCQr8NuYx2dIIytl1QeBEZHJ9uW6hebsrYgbz8hJwUQao3TWCMtmfV8Nu1twOLAw==}

  '@mediabunny/aac-encoder@1.45.0':
    resolution: {integrity: sha512-vLQw8cY7Me6pvTTMkMhOiH9UCuINzfTOETCeDxbGNeNfDqc/7QlxloUH1Ylp/Zz2ek0O8kc6YdygV2vWAPakrA==}
    peerDependencies:
      mediabunny: ^1.0.0

  '@mediabunny/flac-encoder@1.45.0':
    resolution: {integrity: sha512-LfKbAMZVkxRS7PpEIVnWOY/l0KcHv+rjO7pYY3O0TPCZvbHWfrnQjn8JPacPIfuq6Yv7r4f8lhcl7yHSynoRkQ==}
    peerDependencies:
      mediabunny: ^1.0.0

  '@mediabunny/mp3-encoder@1.45.0':
    resolution: {integrity: sha512-Bobi6AaQYEc7TWmPJ8Q0/hcUtBN7pLUC2qjoC7oZR4FcGqGztby6k7A1SWlmswoMOEIhYsOrgDaemrSDAC0QVQ==}
    peerDependencies:
      mediabunny: ^1.0.0

  '@module-federation/error-codes@0.22.0':
    resolution: {integrity: sha512-xF9SjnEy7vTdx+xekjPCV5cIHOGCkdn3pIxo9vU7gEZMIw0SvAEdsy6Uh17xaCpm8V0FWvR0SZoK9Ik6jGOaug==}

  '@module-federation/runtime-core@0.22.0':
    resolution: {integrity: sha512-GR1TcD6/s7zqItfhC87zAp30PqzvceoeDGYTgF3Vx2TXvsfDrhP6Qw9T4vudDQL3uJRne6t7CzdT29YyVxlgIA==}

  '@module-federation/runtime-tools@0.22.0':
    resolution: {integrity: sha512-4ScUJ/aUfEernb+4PbLdhM/c60VHl698Gn1gY21m9vyC1Ucn69fPCA1y2EwcCB7IItseRMoNhdcWQnzt/OPCNA==}

  '@module-federation/runtime@0.22.0':
    resolution: {integrity: sha512-38g5iPju2tPC3KHMPxRKmy4k4onNp6ypFPS1eKGsNLUkXgHsPMBFqAjDw96iEcjri91BrahG4XcdyKi97xZzlA==}

  '@module-federation/sdk@0.22.0':
    resolution: {integrity: sha512-x4aFNBKn2KVQRuNVC5A7SnrSCSqyfIWmm1DvubjbO9iKFe7ith5niw8dqSFBekYBg2Fwy+eMg4sEFNVvCAdo6g==}

  '@module-federation/webpack-bundler-runtime@0.22.0':
    resolution: {integrity: sha512-aM8gCqXu+/4wBmJtVeMeeMN5guw3chf+2i6HajKtQv7SJfxV/f4IyNQJUeUQu9HfiAZHjqtMV5Lvq/Lvh8LdyA==}

  '@napi-rs/wasm-runtime@1.0.7':
    resolution: {integrity: sha512-SeDnOO0Tk7Okiq6DbXmmBODgOAb9dp9gjlphokTUxmt8U3liIP1ZsozBahH69j/RJv+Rfs6IwUKHTgQYJ/HBAw==}

  '@remotion/bundler@4.0.468':
    resolution: {integrity: sha512-jsCzE4KmDLnV+hz4UOWjOJnhzH90LNrnqIrSpwg+Wu5fZip9tPA414qZNKuF+M3Z4riBC4UOJVt5/BQ41Uk0wg==}
    peerDependencies:
      react: '>=16.8.0'
      react-dom: '>=16.8.0'

  '@remotion/compositor-darwin-arm64@4.0.468':
    resolution: {integrity: sha512-wB1m1bSvqU+CGg4qxZt8XGZf+4eDFot58IMy6Z7b2+qHpvE/qdtm2CENvlSuDu/zVO6b10wWbaWGKz0jf2YM0Q==}
    cpu: [arm64]
    os: [darwin]

  '@remotion/compositor-darwin-x64@4.0.468':
    resolution: {integrity: sha512-WdJS1T7zbxHRraK9F6SIpWbfU3UprSeLnmoHtkMhW35o0zfaq3scfprmm1eTHSynlttz2nRwEvNPrNvhbJrBtg==}
    cpu: [x64]
    os: [darwin]

  '@remotion/compositor-linux-arm64-gnu@4.0.468':
    resolution: {integrity: sha512-HEXjGlcL1b/7EfZkJOSs+XQt5mJ88f6SJB/uIHzde3hpYwZvqmtls9zC8wzM6VncIYNQOu8gDxfbVzAZ+Hfv3Q==}
    cpu: [arm64]
    os: [linux]

  '@remotion/compositor-linux-arm64-musl@4.0.468':
    resolution: {integrity: sha512-8Qf14zSsvbAKfWdcrdxhPP4pm0A6qsc72vzWjDIH1XmYAKHg49eOHolQTr6bzNyekMLgJ3eKC66W4UFYny0gfg==}
    cpu: [arm64]
    os: [linux]

  '@remotion/compositor-linux-x64-gnu@4.0.468':
    resolution: {integrity: sha512-PqbgcutSTR3Od3WTkOlMBIgW4sFeylnWYK8Pdcfs81TePD2xFDXEKY45HBYpi58EzSt6zp2qdQAW8b3NrIhEiw==}
    cpu: [x64]
    os: [linux]

  '@remotion/compositor-linux-x64-musl@4.0.468':
    resolution: {integrity: sha512-EtMjnQvaYOvNDGvYqEQdcfznN0sKCf7fT9lA1admcTYJ7h/jxFydj8aTTpvgmA3VG4TN1IL70RSLVu3Esx1Ylg==}
    cpu: [x64]
    os: [linux]

  '@remotion/compositor-win32-x64-msvc@4.0.468':
    resolution: {integrity: sha512-h6fpDu9e1Wfpg5jpYABYwbh1y3uqhkOS3FYfnUCvKNBp+ZpNkla8TfsQsQVoMECtxxOwLHLYesY5BzvUtOZ/5Q==}
    cpu: [x64]
    os: [win32]

  '@remotion/licensing@4.0.468':
    resolution: {integrity: sha512-l0iIn8YVdKiOBYDN1bnbtguMReq/Q7QozxtHr+mKIHr66zeCjhpwFvHklmN/LXMFGWh2OxfNJ6fgXKWS1Iuy3A==}

  '@remotion/media-parser@4.0.468':
    resolution: {integrity: sha512-lh6IGOmVnCsV6oytuGbgr9PB/AkWnWRwBr8tsq7gpjBqhR3oLe3fFd+p7jJreMrF+l4y55bcrf52qT3yxBD9fw==}

  '@remotion/media-utils@4.0.468':
    resolution: {integrity: sha512-at4/faHpezfYuv3WikG1ePQY3pBnjWTgFv2++IRJ4z5+ZneoSM1mtFS9lIJO9maCPRLxJRqHWOI0+rnNrNHADA==}
    peerDependencies:
      react: '>=16.8.0'
      react-dom: '>=16.8.0'

  '@remotion/player@4.0.468':
    resolution: {integrity: sha512-M0kdFnAZvstMctK2ypoTkFOahI61kUE9HnQAh5/9dPb+FlOwCDLRDnM2LBkltZsJxgqgH1nDe1iNPsry0QCjmw==}
    peerDependencies:
      react: '>=16.8.0'
      react-dom: '>=16.8.0'

  '@remotion/renderer@4.0.468':
    resolution: {integrity: sha512-n8fLD9o5W0N4FEz9V7OBmHjiG/Qo36cwH/MaUsEdATCfKIUGlMjrBvyFuKGobl5GHdt3xCyzYQoar3vFiwll8Q==}
    peerDependencies:
      react: '>=16.8.0'
      react-dom: '>=16.8.0'

  '@remotion/streaming@4.0.468':
    resolution: {integrity: sha512-Ts0pq7Lh+ztSvJp5oOTHOc2oKuQ3LtXGfWhQKiJXm81Xz5Qjz3KbPhQ/Z94/GzbZDRrs+zdzwRyqS6pTFnoLdg==}

  '@remotion/studio-shared@4.0.468':
    resolution: {integrity: sha512-PNfOIpQ+tSzOuEbedU+SueyvSXemp2i5IesHwlJgN+70jcbOCt29d5/1MDlJbgcydBe9fMnsrYrosP3ln5kAxA==}

  '@remotion/studio@4.0.468':
    resolution: {integrity: sha512-Wzy/EtI4GLbkExet253KTrwOunJb3ciGFf+/bd0FBOt3plmaPxuJe4iJ4IvMwwA0/xR1U9HkgXg/gPZxzVHsSQ==}
    peerDependencies:
      react: '>=16.8.0'
      react-dom: '>=16.8.0'

  '@remotion/timeline-utils@4.0.468':
    resolution: {integrity: sha512-B99PXVVDILfUurh8QesJAfwZOy56H2oHs6dxf8HUnUN8xMSNKJx62C0zELiYb56KBTT1ryTGxWY64lTaUIuEcw==}

  '@remotion/web-renderer@4.0.468':
    resolution: {integrity: sha512-Ucxw9F7IkqHQdol9qu6UqpQKr29JjeyLrTDPSzDp0ec55MCO7oDvlktYkdc8IGmMQfh0FD8b603phUSXax4XnQ==}
    peerDependencies:
      react: '>=18.0.0'
      react-dom: '>=18.0.0'

  '@remotion/zod-types@4.0.468':
    resolution: {integrity: sha512-W6KejABTdCFZW0P0uVO7Ol7QMD8n/ewaKhyo5AzKx+0CfIelgQREWDXINBzJxZM5XnJXdn9Q0ffDWsBCnQFAaw==}
    peerDependencies:
      zod: 4.3.6

  '@rspack/binding-darwin-arm64@1.7.6':
    resolution: {integrity: sha512-NZ9AWtB1COLUX1tA9HQQvWpTy07NSFfKBU8A6ylWd5KH8AePZztpNgLLAVPTuNO4CZXYpwcoclf8jG/luJcQdQ==}
    cpu: [arm64]
    os: [darwin]

  '@rspack/binding-darwin-x64@1.7.6':
    resolution: {integrity: sha512-J2g6xk8ZS7uc024dNTGTHxoFzFovAZIRixUG7PiciLKTMP78svbSSWrmW6N8oAsAkzYfJWwQpVgWfFNRHvYxSw==}
    cpu: [x64]
    os: [darwin]

  '@rspack/binding-linux-arm64-gnu@1.7.6':
    resolution: {integrity: sha512-eQfcsaxhFrv5FmtaA7+O1F9/2yFDNIoPZzV/ZvqvFz5bBXVc4FAm/1fVpBg8Po/kX1h0chBc7Xkpry3cabFW8w==}
    cpu: [arm64]
    os: [linux]

  '@rspack/binding-linux-arm64-musl@1.7.6':
    resolution: {integrity: sha512-DfQXKiyPIl7i1yECHy4eAkSmlUzzsSAbOjgMuKn7pudsWf483jg0UUYutNgXSlBjc/QSUp7906Cg8oty9OfwPA==}
    cpu: [arm64]
    os: [linux]

  '@rspack/binding-linux-x64-gnu@1.7.6':
    resolution: {integrity: sha512-NdA+2X3lk2GGrMMnTGyYTzM3pn+zNjaqXqlgKmFBXvjfZqzSsKq3pdD1KHZCd5QHN+Fwvoszj0JFsquEVhE1og==}
    cpu: [x64]
    os: [linux]

  '@rspack/binding-linux-x64-musl@1.7.6':
    resolution: {integrity: sha512-rEy6MHKob02t/77YNgr6dREyJ0e0tv1X6Xsg8Z5E7rPXead06zefUbfazj4RELYySWnM38ovZyJAkPx/gOn3VA==}
    cpu: [x64]
    os: [linux]

  '@rspack/binding-wasm32-wasi@1.7.6':
    resolution: {integrity: sha512-YupOrz0daSG+YBbCIgpDgzfMM38YpChv+afZpaxx5Ml7xPeAZIIdgWmLHnQ2rts73N2M1NspAiBwV00Xx0N4Vg==}
    cpu: [wasm32]

  '@rspack/binding-win32-arm64-msvc@1.7.6':
    resolution: {integrity: sha512-INj7aVXjBvlZ84kEhSK4kJ484ub0i+BzgnjDWOWM1K+eFYDZjLdAsQSS3fGGXwVc3qKbPIssFfnftATDMTEJHQ==}
    cpu: [arm64]
    os: [win32]

  '@rspack/binding-win32-ia32-msvc@1.7.6':
    resolution: {integrity: sha512-lXGvC+z67UMcw58In12h8zCa9IyYRmuptUBMItQJzu+M278aMuD1nETyGLL7e4+OZ2lvrnnBIcjXN1hfw2yRzw==}
    cpu: [ia32]
    os: [win32]

  '@rspack/binding-win32-x64-msvc@1.7.6':
    resolution: {integrity: sha512-zeUxEc0ZaPpmaYlCeWcjSJUPuRRySiSHN23oJ2Xyw0jsQ01Qm4OScPdr0RhEOFuK/UE+ANyRtDo4zJsY52Hadw==}
    cpu: [x64]
    os: [win32]

  '@rspack/binding@1.7.6':
    resolution: {integrity: sha512-/NrEcfo8Gx22hLGysanrV6gHMuqZSxToSci/3M4kzEQtF5cPjfOv5pqeLK/+B6cr56ul/OmE96cCdWcXeVnFjQ==}

  '@rspack/core@1.7.6':
    resolution: {integrity: sha512-Iax6UhrfZqJajA778c1d5DBFbSIqPOSrI34kpNIiNpWd8Jq7mFIa+Z60SQb5ZQDZuUxcCZikjz5BxinFjTkg7Q==}
    engines: {node: '>=18.12.0'}
    peerDependencies:
      '@swc/helpers': '>=0.5.1'
    peerDependenciesMeta:
      '@swc/helpers':
        optional: true

  '@rspack/lite-tapable@1.1.0':
    resolution: {integrity: sha512-E2B0JhYFmVAwdDiG14+DW0Di4Ze4Jg10Pc4/lILUrd5DRCaklduz2OvJ5HYQ6G+hd+WTzqQb3QnDNfK4yvAFYw==}

  '@rspack/plugin-react-refresh@1.6.1':
    resolution: {integrity: sha512-eqqW5645VG3CzGzFgNg5HqNdHVXY+567PGjtDhhrM8t67caxmsSzRmT5qfoEIfBcGgFkH9vEg7kzXwmCYQdQDw==}
    peerDependencies:
      react-refresh: '>=0.10.0 <1.0.0'
      webpack-hot-middleware: 2.x
    peerDependenciesMeta:
      webpack-hot-middleware:
        optional: true

  '@tybys/wasm-util@0.10.3':
    resolution: {integrity: sha512-F3fo1MYrRJYL3zER0OUOmkutjr1Vp23m7OsSgp7nq4SP6OqX6C/56XFIPAl5bt3zaBRjmW7SGz3u/6LwFpYcOg==}

  '@types/dom-mediacapture-transform@0.1.12':
    resolution: {integrity: sha512-d7/QsLRwF864A5mgIM/YrfiglHoYn7zgCcAoJgW404r+2DwnNr7EBbLnCWpmOMgH8y0te73L1AV6H1bmauaWFw==}

  '@types/dom-webcodecs@0.1.13':
    resolution: {integrity: sha512-O5hkiFIcjjszPIYyUSyvScyvrBoV3NOEEZx/pMlsu44TKzWNkLVBBxnxJz42in5n3QIolYOcBYFCPZZ0h8SkwQ==}

  '@types/eslint-scope@3.7.7':
    resolution: {integrity: sha512-MzMFlSLBqNF2gcHWO0G1vP/YQyfvrxZ0bF+u7mzUdZ1/xK4A4sru+nraZz5i3iEIk1l1uyicaDVTB4QbbEkAYg==}

  '@types/eslint@9.6.1':
    resolution: {integrity: sha512-FXx2pKgId/WyYo2jXw63kk7/+TY7u7AziEJxJAnSFzHlqTAS3Ync6SvgYAN/k4/PQpnnVuzoMuVnByKK2qp0ag==}

  '@types/estree@1.0.9':
    resolution: {integrity: sha512-GhdPgy1el4/ImP05X05Uw4cw2/M93BCUmnEvWZNStlCzEKME4Fkk+YpoA5OiHNQmoS7Cafb8Xa3Pya8m1Qrzeg==}

  '@types/json-schema@7.0.15':
    resolution: {integrity: sha512-5+fP8P8MFNC+AyZCDxrB2pkZFPGzqQWUzpSeuuVLvm8VMcorNYavBqoFcxK8bQz4Qsbn4oUEEem4wDLfcysGHA==}

  '@types/node@26.4.0':
    resolution: {integrity: sha512-faiGnoIrLH/V8cibOMEAZ8pMw6oXqSukl29ra4mN8GdaB2ZewzeaLj+INpV5N+Z1eKWzY+IzaIZH2EIR6YZRNQ==}

  '@types/prop-types@15.7.15':
    resolution: {integrity: sha512-F6bEyamV9jKGAFBEmlQnesRPGOQqS2+Uwi0Em15xenOxHaf2hv6L8YCVn3rPdPJOiJfPiCnLIRyvwVaqMY3MIw==}

  '@types/react-dom@18.3.5':
    resolution: {integrity: sha512-P4t6saawp+b/dFrUr2cvkVsfvPguwsxtH6dNIYRllMsefqFzkZk5UIjzyDOv5g1dXIPdG4Sp1yCR4Z6RCUsG/Q==}
    peerDependencies:
      '@types/react': ^18.0.0

  '@types/react@18.3.18':
    resolution: {integrity: sha512-t4yC+vtgnkYjNSKlFx1jkAhH8LgTo2N/7Qvi83kdEaUtMDiwpbLAktKDaAMlRcJ5eSxZkH74eEGt1ky31d7kfQ==}

  '@webassemblyjs/ast@1.14.1':
    resolution: {integrity: sha512-nuBEDgQfm1ccRp/8bCQrx1frohyufl4JlbMMZ4P1wpeOfDhF6FQkxZJ1b/e+PLwr6X1Nhw6OLme5usuBWYBvuQ==}

  '@webassemblyjs/floating-point-hex-parser@1.13.2':
    resolution: {integrity: sha512-6oXyTOzbKxGH4steLbLNOu71Oj+C8Lg34n6CqRvqfS2O71BxY6ByfMDRhBytzknj9yGUPVJ1qIKhRlAwO1AovA==}

  '@webassemblyjs/helper-api-error@1.13.2':
    resolution: {integrity: sha512-U56GMYxy4ZQCbDZd6JuvvNV/WFildOjsaWD3Tzzvmw/mas3cXzRJPMjP83JqEsgSbyrmaGjBfDtV7KDXV9UzFQ==}

  '@webassemblyjs/helper-buffer@1.14.1':
    resolution: {integrity: sha512-jyH7wtcHiKssDtFPRB+iQdxlDf96m0E39yb0k5uJVhFGleZFoNw1c4aeIcVUPPbXUVJ94wwnMOAqUHyzoEPVMA==}

  '@webassemblyjs/helper-numbers@1.13.2':
    resolution: {integrity: sha512-FE8aCmS5Q6eQYcV3gI35O4J789wlQA+7JrqTTpJqn5emA4U2hvwJmvFRC0HODS+3Ye6WioDklgd6scJ3+PLnEA==}

  '@webassemblyjs/helper-wasm-bytecode@1.13.2':
    resolution: {integrity: sha512-3QbLKy93F0EAIXLh0ogEVR6rOubA9AoZ+WRYhNbFyuB70j3dRdwH9g+qXhLAO0kiYGlg3TxDV+I4rQTr/YNXkA==}

  '@webassemblyjs/helper-wasm-section@1.14.1':
    resolution: {integrity: sha512-ds5mXEqTJ6oxRoqjhWDU83OgzAYjwsCV8Lo/N+oRsNDmx/ZDpqalmrtgOMkHwxsG0iI//3BwWAErYRHtgn0dZw==}

  '@webassemblyjs/ieee754@1.13.2':
    resolution: {integrity: sha512-4LtOzh58S/5lX4ITKxnAK2USuNEvpdVV9AlgGQb8rJDHaLeHciwG4zlGr0j/SNWlr7x3vO1lDEsuePvtcDNCkw==}

  '@webassemblyjs/leb128@1.13.2':
    resolution: {integrity: sha512-Lde1oNoIdzVzdkNEAWZ1dZ5orIbff80YPdHx20mrHwHrVNNTjNr8E3xz9BdpcGqRQbAEa+fkrCb+fRFTl/6sQw==}

  '@webassemblyjs/utf8@1.13.2':
    resolution: {integrity: sha512-3NQWGjKTASY1xV5m7Hr0iPeXD9+RDobLll3T9d2AO+g3my8xy5peVyjSag4I50mR1bBSN/Ct12lo+R9tJk0NZQ==}

  '@webassemblyjs/wasm-edit@1.14.1':
    resolution: {integrity: sha512-RNJUIQH/J8iA/1NzlE4N7KtyZNHi3w7at7hDjvRNm5rcUXa00z1vRz3glZoULfJ5mpvYhLybmVcwcjGrC1pRrQ==}

  '@webassemblyjs/wasm-gen@1.14.1':
    resolution: {integrity: sha512-AmomSIjP8ZbfGQhumkNvgC33AY7qtMCXnN6bL2u2Js4gVCg8fp735aEiMSBbDR7UQIj90n4wKAFUSEd0QN2Ukg==}

  '@webassemblyjs/wasm-opt@1.14.1':
    resolution: {integrity: sha512-PTcKLUNvBqnY2U6E5bdOQcSM+oVP/PmrDY9NzowJjislEjwP/C4an2303MCVS2Mg9d3AJpIGdUFIQQWbPds0Sw==}

  '@webassemblyjs/wasm-parser@1.14.1':
    resolution: {integrity: sha512-JLBl+KZ0R5qB7mCnud/yyX08jWFw5MsoalJ1pQ4EdFlgj9VdXKGuENGsiCIjegI1W7p91rUlcB/LB5yRJKNTcQ==}

  '@webassemblyjs/wast-printer@1.14.1':
    resolution: {integrity: sha512-kPSSXE6De1XOR820C90RIo2ogvZG+c3KiHzqUoO/F34Y2shGzesfqv7o57xrxovZJH/MetF5UjroJ/R/3isoiw==}

  '@xtuc/ieee754@1.2.0':
    resolution: {integrity: sha512-DX8nKgqcGwsc0eJSqYt5lwP4DH5FlHnmuWWBRy7X0NcaGR0ZtuyeESgMwTYVEtxmsNGY+qit4QYT/MIYTOTPeA==}

  '@xtuc/long@4.2.2':
    resolution: {integrity: sha512-NuHqBY1PB/D8xU6s/thBgOAiAP7HOYDQ32+BFZILJ8ivkUkAHQnWfn6WhL79Owj1qmUnoN/YPhktdIoucipkAQ==}

  acorn-import-phases@1.0.4:
    resolution: {integrity: sha512-wKmbr/DDiIXzEOiWrTTUcDm24kQ2vGfZQvM2fwg2vXqR5uW6aapr7ObPtj1th32b9u90/Pf4AItvdTh42fBmVQ==}
    engines: {node: '>=10.13.0'}
    peerDependencies:
      acorn: ^8.14.0

  acorn@8.18.0:
    resolution: {integrity: sha512-lGq+9yr1/GuAWaVYIHRjvvySG5/4VfKIvC8EWxStPdcDh/Ka7FG3twP6v4d5BkravUilhIAsG4Qj83t02LWUPQ==}
    engines: {node: '>=0.4.0'}
    hasBin: true

  ajv-formats@2.1.1:
    resolution: {integrity: sha512-Wx0Kx52hxE7C18hkMEggYlEifqWZtYaRgouJor+WMdPnQyEK13vgEWyVNup7SoeeoLMsr4kf5h6dOW11I15MUA==}
    peerDependencies:
      ajv: ^8.0.0
    peerDependenciesMeta:
      ajv:
        optional: true

  ajv-keywords@5.1.0:
    resolution: {integrity: sha512-YCS/JNFAUyr5vAuhk1DWm1CBxRHW9LbJ2ozWeemrIqpbsqKjHVxYPyi5GC0rjZIT5JxJ3virVTS8wk4i/Z+krw==}
    peerDependencies:
      ajv: ^8.8.2

  ajv@8.20.0:
    resolution: {integrity: sha512-Thbli+OlOj+iMPYFBVBfJ3OmCAnaSyNn4M1vz9T6Gka5Jt9ba/HIR56joy65tY6kx/FCF5VXNB819Y7/GUrBGA==}

  baseline-browser-mapping@2.11.20:
    resolution: {integrity: sha512-H0ulySigv6icDJ1F7SjtdCD6PrhTpdYCmP0CactWy1+ekh0AFd0o1Wn5T8b+hnTmdBx19u9yhL6wvCylXMY7zw==}
    engines: {node: '>=6.0.0'}
    hasBin: true

  browserslist@4.28.8:
    resolution: {integrity: sha512-V2NpofLblG64mfOtSgDhOJESZEGogzDMBv/q+W6oc4LXWP/q75eOXoOaaOu1EOadB9U4Bwx/e0yzbvwKH8zalA==}
    engines: {node: ^6 || ^7 || ^8 || ^9 || ^10 || ^11 || ^12 || >=13.7}
    hasBin: true

  buffer-from@1.1.2:
    resolution: {integrity: sha512-E+XQCRwSbaaiChtv6k6Dwgc+bx+Bs6vuKJHHl5kox/BaKbhiXzqQOwK4cO22yElGp2OCmjwVhT3HmxgyPGnJfQ==}

  caniuse-lite@1.0.30001810:
    resolution: {integrity: sha512-TITQPUkaz+aVk5GL6NhOdwk1aEaNTSDPsGFWrTuhKGtjTF70jL/Oht2W4c6rXUe5fu7Ie19VIahAXHIIiWWNeg==}

  chrome-trace-event@1.0.4:
    resolution: {integrity: sha512-rNjApaLzuwaOTjCiT8lSDdGN1APCiqkChLMJxJPWLunPAt5fy8xgU9/jNOchV84wfIxrA0lRQB7oCT8jrn/wrQ==}
    engines: {node: '>=6.0'}

  commander@2.20.3:
    resolution: {integrity: sha512-GpVkmM8vF2vQUkj2LvZmD35JxeJOLCwJ9cUkugyk2nuhbv3+mJvpLYYt+0+USMxE+oj+ey/lJEnhZw75x/OMcQ==}

  cross-spawn@7.0.6:
    resolution: {integrity: sha512-uV2QOWP2nWzsy2aMp8aRibhi9dlzF5Hgh5SHaB9OiTGEyDTiJJyx0uy51QXdyWbtAHNua4XJzUKca3OzKUd3vA==}
    engines: {node: '>= 8'}

  css-loader@7.1.4:
    resolution: {integrity: sha512-vv3J9tlOl04WjiMvHQI/9tmIrCxVrj6PFbHemBB1iihpeRbi/I4h033eoFIhwxBBqLhI0KYFS7yvynBFhIZfTw==}
    engines: {node: '>= 18.12.0'}
    peerDependencies:
      '@rspack/core': 0.x || ^1.0.0 || ^2.0.0-0
      webpack: ^5.27.0
    peerDependenciesMeta:
      '@rspack/core':
        optional: true
      webpack:
        optional: true

  cssesc@3.0.0:
    resolution: {integrity: sha512-/Tb/JcjK111nNScGob5MNtsntNM1aCNUDipB/TkwZFhyDrrE47SOx/18wF2bbjgc3ZzCSKW1T5nt5EbFoAz/Vg==}
    engines: {node: '>=4'}
    hasBin: true

  csstype@3.2.3:
    resolution: {integrity: sha512-z1HGKcYy2xA8AGQfwrn0PAy+PB7X/GSj3UVJW9qKyn43xWa+gl5nXmU4qqLMRzWVLFC8KusUX8T/0kCiOYpAIQ==}

  define-lazy-prop@2.0.0:
    resolution: {integrity: sha512-Ds09qNh8yw3khSjiJjiUInaGX9xlqZDY7JVryGxdxV7NPeuqQfplOpQ66yJFZut3jLa5zOwkXw1g9EI2uKh4Og==}
    engines: {node: '>=8'}

  electron-to-chromium@1.5.417:
    resolution: {integrity: sha512-4T+DTDWuMPM4aHlHwWdAVCVWwp7LDilnhzkj+c/Lbj91XSQrLuOmZSLtS9Q4iIqjlPUbPOnC624zDVVHCHaolQ==}

  enhanced-resolve@5.24.5:
    resolution: {integrity: sha512-L1l8TNvomm6UVW5B253AGxQagSQr+vGwhMlrrfRS2qmhx46AMpMVJKQYLvWYbysTMY8VoicOvzHzoHMbyzB+4A==}
    engines: {node: '>=10.13.0'}

  error-stack-parser@2.1.4:
    resolution: {integrity: sha512-Sk5V6wVazPhq5MhpO+AUxJn5x7XSXGl1R93Vn7i+zS15KDVxQijejNCrz8340/2bgLBjR9GtEG8ZVKONDjcqGQ==}

  es-module-lexer@2.3.2:
    resolution: {integrity: sha512-poHGpORABojJJucnV9KbOavETW8lBVnphkW77ER5/BQ5Fz7oXSoCNek7IH3vR5nRjdsEz926ibFYX8KtLQmdyw==}

  esbuild@0.28.0:
    resolution: {integrity: sha512-sNR9MHpXSUV/XB4zmsFKN+QgVG82Cc7+/aaxJ8Adi8hyOac+EXptIp45QBPaVyX3N70664wRbTcLTOemCAnyqw==}
    engines: {node: '>=18'}
    hasBin: true

  escalade@3.2.0:
    resolution: {integrity: sha512-WUj2qlxaQtO4g6Pq5c29GTcWGDyd8itL8zTlipgECz3JesAiiOKotd8JU6otB3PACgG6xkJUyVhboMS+bje/jA==}
    engines: {node: '>=6'}

  eslint-scope@5.1.1:
    resolution: {integrity: sha512-2NxwbF/hZ0KpepYN0cNbo+FN6XoK7GaHlQhgx/hIZl6Va0bF45RQOOwhLIy8lQDbuCiadSLCBnH2CFYquit5bw==}
    engines: {node: '>=8.0.0'}

  esrecurse@4.3.0:
    resolution: {integrity: sha512-KmfKL3b6G+RXvP8N1vr3Tq1kL/oCFgn2NYXEtqP8/L3pKapUA4G8cFVaoF3SU323CD4XypR/ffioHmkti6/Tag==}
    engines: {node: '>=4.0'}

  estraverse@4.3.0:
    resolution: {integrity: sha512-39nnKffWz8xN1BU/2c79n9nB9HDzo0niYUqx6xyqUnyoAnQyyWpOTdZEeiCch8BBu515t4wp9ZmgVfVhn9EBpw==}
    engines: {node: '>=4.0'}

  estraverse@5.3.0:
    resolution: {integrity: sha512-MMdARuVEQziNTeJD8DgMqmhwR11BRQ/cBP+pLtYdSTnf3MIO8fFeiINEbX36ZdNlfU/7A9f3gUw49B3oQsvwBA==}
    engines: {node: '>=4.0'}

  events@3.3.0:
    resolution: {integrity: sha512-mQw+2fkQbALzQ7V0MY0IqdnXNOeTtP4r0lN9z7AAawCXgqea7bDii20AYrIBrFd/Hx0M2Ocz6S111CaFkUcb0Q==}
    engines: {node: '>=0.8.x'}

  execa@5.1.1:
    resolution: {integrity: sha512-8uSpZZocAZRBAPIEINJj3Lo9HyGitllczc27Eh5YYojjMFMn8yHMDMaUHE2Jqfq05D/wucwI4JGURyXt1vchyg==}
    engines: {node: '>=10'}

  fast-deep-equal@3.1.3:
    resolution: {integrity: sha512-f3qQ9oQy9j2AhBe/H9VC91wLmKBCCU/gDOnKNAYG5hswO7BLKj09Hc5HYNz9cGI++xlpDCIgDaitVs03ATR84Q==}

  fast-uri@3.1.6:
    resolution: {integrity: sha512-7Ical1vFEMr0onbVzEDIreM22I4khW+fzyQPwvAFWBp1iwdshSZRsL4jjRvPG9JP1uiqMHRto+YU6R2/CzDz5Q==}

  fs-monkey@1.0.3:
    resolution: {integrity: sha512-cybjIfiiE+pTWicSCLFHSrXZ6EilF30oh91FDP9S2B051prEa7QWfrVTQm10/dDpswBDXZugPa1Ogu8Yh+HV0Q==}

  get-stream@6.0.1:
    resolution: {integrity: sha512-ts6Wi+2j3jQjqi70w5AlN8DFnkSwC+MqmxEzdEALB2qXZYV3X/b1CTfgPLGJNMeAWxdPfU8FO1ms3NUfaHCPYg==}
    engines: {node: '>=10'}

  glob-to-regexp@0.4.1:
    resolution: {integrity: sha512-lkX1HJXwyMcprw/5YUZc2s7DrpAiHB21/V+E1rHUrVNokkvB6bqMzT0VfV6/86ZNabt1k14YOIaT7nDvOX3Iiw==}

  graceful-fs@4.2.11:
    resolution: {integrity: sha512-RbJ5/jmFcNNCcDV5o9eTnBLJ/HszWV0P73bc+Ff4nS/rJj+YaS6IGyiOL0VoBYX+l1Wrl3k63h/KrH+nhJ0XvQ==}

  has-flag@4.0.0:
    resolution: {integrity: sha512-EykJT/Q1KjTWctppgIAgfSO0tKVuZUjhgMr17kqTumMl6Afv3EISleU7qZUzoXDFTAHTDC4NOoG/ZxU3EvlMPQ==}
    engines: {node: '>=8'}

  html-entities@2.6.0:
    resolution: {integrity: sha512-kig+rMn/QOVRvr7c86gQ8lWXq+Hkv6CbAH1hLu+RG338StTpE8Z0b44SDVaqVu7HGKf27frdmUYEs9hTUX/cLQ==}

  human-signals@2.1.0:
    resolution: {integrity: sha512-B4FFZ6q/T2jhhksgkbEW3HBvWIfDW85snkQgawt07S7J5QXTk6BkNV+0yAeZrM5QpMAdYlocGoljn0sJ/WQkFw==}
    engines: {node: '>=10.17.0'}

  icss-utils@5.1.0:
    resolution: {integrity: sha512-soFhflCVWLfRNOPU3iv5Z9VUdT44xFRbzjLsEzSr5AQmgqPMTHdU3PMT1Cf1ssx8fLNJDA1juftYl+PUcv3MqA==}
    engines: {node: ^10 || ^12 || >= 14}
    peerDependencies:
      postcss: ^8.1.0

  is-docker@2.2.1:
    resolution: {integrity: sha512-F+i2BKsFrH66iaUFc0woD8sLy8getkwTwtOBjvs56Cx4CgJDeKQeqfz8wAYiSb8JOprWhHH5p77PbmYCvvUuXQ==}
    engines: {node: '>=8'}
    hasBin: true

  is-stream@2.0.1:
    resolution: {integrity: sha512-hFoiJiTl63nn+kstHGBtewWSKnQLpyb155KHheA1l39uvtO9nWIop1p3udqPcUd/xbF1VLMO4n7OI6p7RbngDg==}
    engines: {node: '>=8'}

  is-wsl@2.2.0:
    resolution: {integrity: sha512-fKzAra0rGJUUBwGBgNkHZuToZcn+TtXHpeCgmkMJMMYx1sQDYaCSyjJBSCa2nH1DGm7s3n1oBnohoVTBaN7Lww==}
    engines: {node: '>=8'}

  isexe@2.0.0:
    resolution: {integrity: sha512-RHxMLp9lnKHGHRng9QFhRCMbYAcVpn69smSGcq3f36xjgVVWThj4qqLbTLlq7Ssj8B+fIQ1EuCEGI2lKsyQeIw==}

  jest-worker@27.5.1:
    resolution: {integrity: sha512-7vuh85V5cdDofPyxn58nrPjBktZo0u9x1g8WtjQol+jZDaE+fhN+cIvTj11GndBnMnyfrUOG1sZQxCdjKh+DKg==}
    engines: {node: '>= 10.13.0'}

  js-tokens@4.0.0:
    resolution: {integrity: sha512-RdJUflcE3cUzKiMqQgsCu06FPu9UdIJO0beYbPhHN4k6apgJtifcoCtT9bcxOpYBtpD2kCM6Sbzg4CausW/PKQ==}

  json-parse-even-better-errors@2.3.1:
    resolution: {integrity: sha512-xyFwyhro/JEof6Ghe2iz2NcXoj2sloNsWr/XsERDK/oiPCfaNhl5ONfp+jQdAZRQQ0IJWNzH9zIZF7li91kh2w==}

  json-schema-traverse@1.0.0:
    resolution: {integrity: sha512-NM8/P9n3XjXhIZn1lLhkFaACTOURQXjWhV4BA/RnOv8xvgqtqpAX9IO4mRQxSx1Rlo4tqzeqb0sOlruaOy3dug==}

  loader-runner@4.3.2:
    resolution: {integrity: sha512-DFEqQ3ihfS9blba08cLfYf1NRAIEm+dDjic073DRDc3/JspI/8wYmtDsHwd3+4hwvdxSK7PGaElfTmm0awWJ4w==}
    engines: {node: '>=6.11.5'}

  lodash.sortby@4.7.0:
    resolution: {integrity: sha512-HDWXG8isMntAyRF5vZ7xKuEvOhT4AhlRt/3czTSjvGUxjYCBVRQY48ViDHyfYz9VIoBkW4TMGQNapx+l3RUwdA==}

  loose-envify@1.4.0:
    resolution: {integrity: sha512-lyuxPGr/Wfhrlem2CL/UcnUc1zcqKAImBDzukY7Y5F/yQiNdko6+fRLevlw1HgMySw7f611UIY408EtxRSoK3Q==}
    hasBin: true

  lru-cache@6.0.0:
    resolution: {integrity: sha512-Jo6dJ04CmSjuznwJSS3pUeWmd/H0ffTlkXXgwZi+eq1UCmqQwCh+eLsYOYCwY991i2Fah4h1BEMCx4qThGbsiA==}
    engines: {node: '>=10'}

  mediabunny@1.45.0:
    resolution: {integrity: sha512-oK3sMMYbucoF6LUX62L/2M9d+p9ve6KDQgL87kNfhsB0/XmTe9iRLUcgQgg9Gpgvi8Sb96zYfOUL6i17y0bdNg==}

  memfs@3.4.3:
    resolution: {integrity: sha512-eivjfi7Ahr6eQTn44nvTnR60e4a1Fs1Via2kCR5lHo/kyNoiMWaXCNJ/GpSd0ilXas2JSOl9B5FTIhflXu0hlg==}
    engines: {node: '>= 4.0.0'}

  merge-stream@2.0.0:
    resolution: {integrity: sha512-abv/qOcuPfk3URPfDzmZU1LKmuw8kT+0nIHvKrKgFrwifol/doWcdA4ZqsWQ8ENrFKkd67Mfpo/LovbIUsbt3w==}

  mime-db@1.52.0:
    resolution: {integrity: sha512-sPU4uV7dYlvtWJxwwxHD0PuihVNiE7TyAbQ5SWxDCB9mUYvOgroQOwYQQOKPJ8CIbE+1ETVlOoK1UC2nU3gYvg==}
    engines: {node: '>= 0.6'}

  mime-types@2.1.35:
    resolution: {integrity: sha512-ZDY+bPm5zTTF+YpCrAU9nK0UgICYPT0QtT1NZWFv4s++TNkcgVaT0g6+4R2uI4MjQjzysHB1zxuWL50hzaeXiw==}
    engines: {node: '>= 0.6'}

  mimic-fn@2.1.0:
    resolution: {integrity: sha512-OqbOk5oEQeAZ8WXWydlu9HJjz9WVdEIvamMCcXmuqUYjTknH/sqsWvhQ3vgwKFRR1HpjvNBKQ37nbJgYzGqGcg==}
    engines: {node: '>=6'}

  nanoid@3.3.18:
    resolution: {integrity: sha512-DTg4MJbGMWkfi6VZFdNt2/caMbQy4Ou+Op/hJQvGEWcnVfoA1QA+xzRKAzw9jD6+GVOOeYr/mIcuDSdug6F6+w==}
    engines: {node: ^10 || ^12 || ^13.7 || ^14 || >=15.0.1}
    hasBin: true

  neo-async@2.6.2:
    resolution: {integrity: sha512-Yd3UES5mWCSqR+qNT93S3UoYUkqAZ9lLg8a7g9rimsWmYGK8cVToA4/sF3RrshdyV3sAGMXVUmpMYOw+dLpOuw==}

  node-releases@2.0.54:
    resolution: {integrity: sha512-YHs7BmmcsdAI5Ozuf8JZo6PT0mv2GIWC9vMfvUC3dp65M8hn7Ux8CPL+2oBI7juNuj9d0ndhTcznq2ODBps9cQ==}
    engines: {node: '>=18'}

  npm-run-path@4.0.1:
    resolution: {integrity: sha512-S48WzZW777zhNIrn7gxOlISNAqi9ZC/uQFnRdbeIHhZhCA6UqpkOT8T1G7BvfdgP4Er8gF4sUbaS0i7QvIfCWw==}
    engines: {node: '>=8'}

  onetime@5.1.2:
    resolution: {integrity: sha512-kbpaSSGJTWdAY5KPVeMOKXSrPtr8C8C7wodJbcsd51jRnmD+GZu8Y0VoU6Dm5Z4vWr0Ig/1NKuWRKf7j5aaYSg==}
    engines: {node: '>=6'}

  open@8.4.2:
    resolution: {integrity: sha512-7x81NCL719oNbsq/3mh+hVrAWmFuEYUqrq/Iw3kUzH8ReypT9QQ0BLoJS7/G9k6N81XjW4qHWtjWwe/9eLy1EQ==}
    engines: {node: '>=12'}

  path-key@3.1.1:
    resolution: {integrity: sha512-ojmeN0qd+y0jszEtoY48r0Peq5dwMEkIlCOu6Q5f41lfkswXuKtYrhgoTpLnyIcHm24Uhqx+5Tqm2InSwLhE6Q==}
    engines: {node: '>=8'}

  picocolors@1.1.1:
    resolution: {integrity: sha512-xceH2snhtb5M9liqDsmEw56le376mTZkEX/jEb/RxNFyegNul7eNslCXP9FDj/Lcu0X8KEyMceP2ntpaHrDEVA==}

  postcss-modules-extract-imports@3.1.0:
    resolution: {integrity: sha512-k3kNe0aNFQDAZGbin48pL2VNidTF0w4/eASDsxlyspobzU3wZQLOGj7L9gfRe0Jo9/4uud09DsjFNH7winGv8Q==}
    engines: {node: ^10 || ^12 || >= 14}
    peerDependencies:
      postcss: ^8.1.0

  postcss-modules-local-by-default@4.2.0:
    resolution: {integrity: sha512-5kcJm/zk+GJDSfw+V/42fJ5fhjL5YbFDl8nVdXkJPLLW+Vf9mTD5Xe0wqIaDnLuL2U6cDNpTr+UQ+v2HWIBhzw==}
    engines: {node: ^10 || ^12 || >= 14}
    peerDependencies:
      postcss: ^8.1.0

  postcss-modules-scope@3.2.1:
    resolution: {integrity: sha512-m9jZstCVaqGjTAuny8MdgE88scJnCiQSlSrOWcTQgM2t32UBe+MUmFSO5t7VMSfAf/FJKImAxBav8ooCHJXCJA==}
    engines: {node: ^10 || ^12 || >= 14}
    peerDependencies:
      postcss: ^8.1.0

  postcss-modules-values@4.0.0:
    resolution: {integrity: sha512-RDxHkAiEGI78gS2ofyvCsu7iycRv7oqw5xMWn9iMoR0N/7mf9D50ecQqUo5BZ9Zh2vH4bCUR/ktCqbB9m8vJjQ==}
    engines: {node: ^10 || ^12 || >= 14}
    peerDependencies:
      postcss: ^8.1.0

  postcss-selector-parser@7.1.5:
    resolution: {integrity: sha512-KvvtD7SrlBP7dlgkBghEE3r84CABm5SmV2aNcG4oCA+qDnJ/tvKonFVvwWAyyWUEwxuNawdfEAZKP9zM3oZ2Uw==}
    engines: {node: '>=4'}

  postcss-value-parser@4.2.0:
    resolution: {integrity: sha512-1NNCs6uurfkVbeXG4S8JFT9t19m45ICnif8zWLd5oPSZ50QnwMfK+H3jv408d4jw/7Bttv5axS5IiHoLaVNHeQ==}

  postcss@8.5.26:
    resolution: {integrity: sha512-u82N74LFzG8ca+dD8puPnplTXoGH4fTPpVGuIbt36G3qvNlkvfD0lEAZSxaly3KX8TS/L1A1gsCEmvKmBcVbkQ==}
    engines: {node: ^10 || ^12 || >=14}

  punycode@2.3.1:
    resolution: {integrity: sha512-vYt7UD1U9Wg6138shLtLOvdAu+8DsC/ilFtEVHcH+wydcSpNE20AfSOduf6MkRFahL5FY7X1oU7nKVZFtfq8Fg==}
    engines: {node: '>=6'}

  react-dom@18.3.1:
    resolution: {integrity: sha512-5m4nQKp+rZRb09LNH59GM4BxTh9251/ylbKIbpe7TpGxfJ+9kv6BLkLBXIjjspbgbnIBNqlI23tRnTWT0snUIw==}
    peerDependencies:
      react: ^18.3.1

  react-refresh@0.18.0:
    resolution: {integrity: sha512-QgT5//D3jfjJb6Gsjxv0Slpj23ip+HtOpnNgnb2S5zU3CB26G/IDPGoy4RJB42wzFE46DRsstbW6tKHoKbhAxw==}
    engines: {node: '>=0.10.0'}

  react@18.3.1:
    resolution: {integrity: sha512-wS+hAgJShR0KhEvPJArfuPVN1+Hz1t0Y6n5jLrGQbkb4urgPE/0Rve+1kMB1v/oWgHgm4WIcV+i7F2pTVj+2iQ==}
    engines: {node: '>=0.10.0'}

  remotion@4.0.468:
    resolution: {integrity: sha512-TPfoy8XZgKDgZDRseAiLpWfLUdix3+d6pL7eh9myPBW2ajdb6tAPzTd9BBKMp/9j+Ajpc5DZVqKuGQPHmBkGQA==}
    peerDependencies:
      react: '>=16.8.0'
      react-dom: '>=16.8.0'

  require-from-string@2.0.2:
    resolution: {integrity: sha512-Xf0nWe6RseziFMu+Ap9biiUbmplq6S9/p+7w7YXP/JBHhrUDDUhwa+vANyubuqfZWTveU//DYVGsDG7RKL/vEw==}
    engines: {node: '>=0.10.0'}

  scheduler@0.23.2:
    resolution: {integrity: sha512-UOShsPwz7NrMUqhR6t0hWjFduvOzbtv7toDH1/hIrfRNIDBnnBWd0CwJTGvTpngVlmwGCdP9/Zl/tVrDqcuYzQ==}

  schema-utils@4.3.3:
    resolution: {integrity: sha512-eflK8wEtyOE6+hsaRVPxvUKYCpRgzLqDTb8krvAsRIwOGlHoSgYLgBXoubGgLd2fT41/OUYdb48v4k4WWHQurA==}
    engines: {node: '>= 10.13.0'}

  semver@7.5.3:
    resolution: {integrity: sha512-QBlUtyVk/5EeHbi7X0fw6liDZc7BBmEaSYn01fMU1OUYbf6GPsbTtd8WmnqbI20SeycoHSeiybkE/q1Q+qlThQ==}
    engines: {node: '>=10'}
    hasBin: true

  semver@7.8.5:
    resolution: {integrity: sha512-Y7/KDsb8LjooZpwaqGyulO6DQlksgCncchHGk+sZIY4SBvUocMBEFH5Ur1fI4dV+Jvl0w6cjvucaIi40puRioA==}
    engines: {node: '>=10'}
    hasBin: true

  shebang-command@2.0.0:
    resolution: {integrity: sha512-kHxr2zZpYtdmrN1qDjrrX/Z1rR1kG8Dx+gkpK1G4eXmvXswmcE1hTWBWYUzlraYw1/yZp6YuDY77YtvbN0dmDA==}
    engines: {node: '>=8'}

  shebang-regex@3.0.0:
    resolution: {integrity: sha512-7++dFhtcx3353uBaq8DDR4NuxBetBzC7ZQOhmTQInHEd6bSrXdiEyzCvG07Z44UYdLShWUyXt5M/yhz8ekcb1A==}
    engines: {node: '>=8'}

  signal-exit@3.0.7:
    resolution: {integrity: sha512-wnD2ZE+l+SPC/uoS0vXeE9L1+0wuaMqKlfz9AMUo38JsyLSBWSFcHR1Rri62LZc12vLr1gb3jl7iwQhgwpAbGQ==}

  source-map-js@1.2.1:
    resolution: {integrity: sha512-UXWMKhLOwVKb728IUtQPXxfYU+usdybtUrK/8uGE8CQMvrhOpwvzDBwj0QhSL7MQc7vIsISBG8VQ8+IDQxpfQA==}
    engines: {node: '>=0.10.0'}

  source-map-support@0.5.21:
    resolution: {integrity: sha512-uBHU3L3czsIyYXKX88fdrGovxdSCoTGDRZ6SYXtSRxLZUzHg5P/66Ht6uoUlHu9EZod+inXhKo3qQgwXUT/y1w==}

  source-map@0.6.1:
    resolution: {integrity: sha512-UjgapumWlbMhkBgzT7Ykc5YXUT46F0iKu8SGXq0bcwP5dz/h0Plj6enJqjz1Zbq2l5WaqYnrVbwWOWMyF3F47g==}
    engines: {node: '>=0.10.0'}

  source-map@0.8.0-beta.0:
    resolution: {integrity: sha512-2ymg6oRBpebeZi9UUNsgQ89bhx01TcTkmNTGnNO88imTmbSgy4nfujrgVEFKWpMTEGA11EDkTt7mqObTPdigIA==}
    engines: {node: '>= 8'}
    deprecated: The work that was done in this beta branch won't be included in future versions

  stackframe@1.3.4:
    resolution: {integrity: sha512-oeVtt7eWQS+Na6F//S4kJ2K2VbRlS9D43mAlMyVpVWovy9o+jfgH8O9agzANzaiLjclA0oYzUXEM4PurhSUChw==}

  strip-final-newline@2.0.0:
    resolution: {integrity: sha512-BrpvfNAE3dcvq7ll3xVumzjKjZQ5tI1sEUIKr3Uoks0XUl45St3FlatVqef9prk4jRDzhW6WZg+3bk93y6pLjA==}
    engines: {node: '>=6'}

  style-loader@4.0.0:
    resolution: {integrity: sha512-1V4WqhhZZgjVAVJyt7TdDPZoPBPNHbekX4fWnCJL1yQukhCeZhJySUL+gL9y6sNdN95uEOS83Y55SqHcP7MzLA==}
    engines: {node: '>= 18.12.0'}
    peerDependencies:
      webpack: ^5.27.0

  supports-color@8.1.1:
    resolution: {integrity: sha512-MpUEN2OodtUzxvKQl72cUF7RQ5EiHsGvSsVG0ia9c5RbWGL2CI4C7EpPS8UTBIplnlzZiNuV56w+FuNxy3ty2Q==}
    engines: {node: '>=10'}

  tapable@2.3.3:
    resolution: {integrity: sha512-uxc/zpqFg6x7C8vOE7lh6Lbda8eEL9zmVm/PLeTPBRhh1xCgdWaQ+J1CUieGpIfm2HdtsUpRv+HshiasBMcc6A==}
    engines: {node: '>=6'}

  terser-webpack-plugin@5.6.1:
    resolution: {integrity: sha512-201R5j+sJpK8nFWwKVyNfZot8FaJbLZDq5evriVzbV1wDtSXDjRUDRfJzHpAaxFDMEhsZL1QkeqM61wgsS3KaQ==}
    engines: {node: '>= 10.13.0'}
    peerDependencies:
      '@minify-html/node': '*'
      '@swc/core': '*'
      '@swc/css': '*'
      '@swc/html': '*'
      clean-css: '*'
      cssnano: '*'
      csso: '*'
      esbuild: '*'
      html-minifier-terser: '*'
      lightningcss: '*'
      postcss: '*'
      uglify-js: '*'
      webpack: ^5.1.0
    peerDependenciesMeta:
      '@minify-html/node':
        optional: true
      '@swc/core':
        optional: true
      '@swc/css':
        optional: true
      '@swc/html':
        optional: true
      clean-css:
        optional: true
      cssnano:
        optional: true
      csso:
        optional: true
      esbuild:
        optional: true
      html-minifier-terser:
        optional: true
      lightningcss:
        optional: true
      postcss:
        optional: true
      uglify-js:
        optional: true

  terser@5.51.2:
    resolution: {integrity: sha512-bWnjSNscmuI+GJze6ZupnHP8G/cTcsJF+bXCeQknk2SHQsgbNJnLrqiH9jZ2W4STPVXH2mDKKRX3iwPhc9Cn/Q==}
    engines: {node: '>=10'}
    hasBin: true

  tr46@1.0.1:
    resolution: {integrity: sha512-dTpowEjclQ7Kgx5SdBkqRzVhERQXov8/l9Ft9dVM9fmg0W0KQSVaXX9T4i6twCPNtYiZM53lpSSUAwJbFPOHxA==}

  tslib@2.8.1:
    resolution: {integrity: sha512-oJFu94HQb+KVduSUQL7wnpmqnfmLsOA/nAh6b6EH0wCEoK0/mPeXU6c3wKDV83MkOuHPRHtSXKKU99IBazS/2w==}

  typescript@5.9.2:
    resolution: {integrity: sha512-CWBzXQrc/qOkhidw1OzBTQuYRbfyxDXJMVJ1XNwUHGROVmuaeiEm3OslpZ1RV96d7SKKjZKrSJu3+t/xlw3R9A==}
    engines: {node: '>=14.17'}
    hasBin: true

  undici-types@8.3.0:
    resolution: {integrity: sha512-j375ScV60dom+YkPFIfTLcOiPxkN/buHz5GobjLhixFuANaNs3C9l4GmrWqejgXWJ7BbJcFYpTEUkS1Ge8bpZQ==}

  update-browserslist-db@1.3.2:
    resolution: {integrity: sha512-UQ+MSxlhRm1bzjhU+DcuXfjFO1FzNtqhK5+9Yvlp90ItDLk5vT932A0rFu619nf7RVS+Y/VeaUW1jaRDqZ8VJw==}
    hasBin: true
    peerDependencies:
      browserslist: '>= 4.21.0'

  util-deprecate@1.0.2:
    resolution: {integrity: sha512-EPD5q1uXyFxJpCrLnCc1nHnq3gOa6DZBocAIiI2TaSCA7VCJ1UJDMagCzIkXNsUYfD1daK//LTEQ8xiIbrHtcw==}

  watchpack@2.5.2:
    resolution: {integrity: sha512-6i/00NBjP4yGPs+caKSyRfpTF/8Torsu0MOW3mMzIbhgISFder8i7xbqgHlLMwJrdiN8ndBV3UA1/AfzPSr+jg==}
    engines: {node: '>=10.13.0'}

  webidl-conversions@4.0.2:
    resolution: {integrity: sha512-YQ+BmxuTgd6UXZW3+ICGfyqRyHXVlD5GtQr5+qjiNW7bF0cqrzX500HVXPBOvgXb5YnzDd+h0zqyv61KUD7+Sg==}

  webpack-sources@3.5.1:
    resolution: {integrity: sha512-jyuiGJdtvY434z5bUZrjz67v76/ePNvFZTp9Mdz29IlH4+GPsgyGjiv0fKI+M7BdkU6ADjulUcKAd3tUK3WlEw==}
    engines: {node: '>=10.13.0'}

  webpack@5.105.0:
    resolution: {integrity: sha512-gX/dMkRQc7QOMzgTe6KsYFM7DxeIONQSui1s0n/0xht36HvrgbxtM1xBlgx596NbpHuQU8P7QpKwrZYwUX48nw==}
    engines: {node: '>=10.13.0'}
    hasBin: true
    peerDependencies:
      webpack-cli: '*'
    peerDependenciesMeta:
      webpack-cli:
        optional: true

  whatwg-url@7.1.0:
    resolution: {integrity: sha512-WUu7Rg1DroM7oQvGWfOiAK21n74Gg+T4elXEQYkOhtyLeWiJFoOGLXPKI/9gzIie9CtwVLm8wtw6YJdKyxSjeg==}

  which@2.0.2:
    resolution: {integrity: sha512-BLI3Tl1TW3Pvl70l3yq3Y64i+awpwXqsGBYWkkqMtnbXgrMD+yj7rhW0kuEDxzJaYXGjEW5ogapKNMEKNMjibA==}
    engines: {node: '>= 8'}
    hasBin: true

  ws@8.20.1:
    resolution: {integrity: sha512-It4dO0K5v//JtTXuPkfEOaI3uUN87iYPnqo/ZzqCoG3g8uhA66QUMs/SrM0YK7/NAu+r4LMh/9dq2A7k+rHs+w==}
    engines: {node: '>=10.0.0'}
    peerDependencies:
      bufferutil: ^4.0.1
      utf-8-validate: '>=5.0.2'
    peerDependenciesMeta:
      bufferutil:
        optional: true
      utf-8-validate:
        optional: true

  yallist@4.0.0:
    resolution: {integrity: sha512-3wdGidZyq5PB084XLES5TpOSRA3wjXAlIWMhum2kRcv/41Sn2emQ0dycQW4uZXLejwKvg6EsvbdlVL+FYEct7A==}

  zod@4.3.6:
    resolution: {integrity: sha512-rftlrkhHZOcjDwkGlnUtZZkvaPHCsDATp4pGpuOOMDaTdDDXF91wuVDJoWoPsKX/3YPQ5fHuF3STjcYyKr+Qhg==}

snapshots:

  '@emnapi/core@1.11.3':
    dependencies:
      '@emnapi/wasi-threads': 1.2.3
      tslib: 2.8.1
    optional: true

  '@emnapi/runtime@1.11.3':
    dependencies:
      tslib: 2.8.1
    optional: true

  '@emnapi/wasi-threads@1.2.3':
    dependencies:
      tslib: 2.8.1
    optional: true

  '@esbuild/aix-ppc64@0.28.0':
    optional: true

  '@esbuild/android-arm64@0.28.0':
    optional: true

  '@esbuild/android-arm@0.28.0':
    optional: true

  '@esbuild/android-x64@0.28.0':
    optional: true

  '@esbuild/darwin-arm64@0.28.0':
    optional: true

  '@esbuild/darwin-x64@0.28.0':
    optional: true

  '@esbuild/freebsd-arm64@0.28.0':
    optional: true

  '@esbuild/freebsd-x64@0.28.0':
    optional: true

  '@esbuild/linux-arm64@0.28.0':
    optional: true

  '@esbuild/linux-arm@0.28.0':
    optional: true

  '@esbuild/linux-ia32@0.28.0':
    optional: true

  '@esbuild/linux-loong64@0.28.0':
    optional: true

  '@esbuild/linux-mips64el@0.28.0':
    optional: true

  '@esbuild/linux-ppc64@0.28.0':
    optional: true

  '@esbuild/linux-riscv64@0.28.0':
    optional: true

  '@esbuild/linux-s390x@0.28.0':
    optional: true

  '@esbuild/linux-x64@0.28.0':
    optional: true

  '@esbuild/netbsd-arm64@0.28.0':
    optional: true

  '@esbuild/netbsd-x64@0.28.0':
    optional: true

  '@esbuild/openbsd-arm64@0.28.0':
    optional: true

  '@esbuild/openbsd-x64@0.28.0':
    optional: true

  '@esbuild/openharmony-arm64@0.28.0':
    optional: true

  '@esbuild/sunos-x64@0.28.0':
    optional: true

  '@esbuild/win32-arm64@0.28.0':
    optional: true

  '@esbuild/win32-ia32@0.28.0':
    optional: true

  '@esbuild/win32-x64@0.28.0':
    optional: true

  '@jridgewell/gen-mapping@0.3.13':
    dependencies:
      '@jridgewell/sourcemap-codec': 1.6.0
      '@jridgewell/trace-mapping': 0.3.31

  '@jridgewell/resolve-uri@3.1.2': {}

  '@jridgewell/source-map@0.3.11':
    dependencies:
      '@jridgewell/gen-mapping': 0.3.13
      '@jridgewell/trace-mapping': 0.3.31

  '@jridgewell/sourcemap-codec@1.6.0': {}

  '@jridgewell/trace-mapping@0.3.31':
    dependencies:
      '@jridgewell/resolve-uri': 3.1.2
      '@jridgewell/sourcemap-codec': 1.6.0

  '@mediabunny/aac-encoder@1.45.0(mediabunny@1.45.0)':
    dependencies:
      mediabunny: 1.45.0

  '@mediabunny/flac-encoder@1.45.0(mediabunny@1.45.0)':
    dependencies:
      mediabunny: 1.45.0

  '@mediabunny/mp3-encoder@1.45.0(mediabunny@1.45.0)':
    dependencies:
      mediabunny: 1.45.0

  '@module-federation/error-codes@0.22.0': {}

  '@module-federation/runtime-core@0.22.0':
    dependencies:
      '@module-federation/error-codes': 0.22.0
      '@module-federation/sdk': 0.22.0

  '@module-federation/runtime-tools@0.22.0':
    dependencies:
      '@module-federation/runtime': 0.22.0
      '@module-federation/webpack-bundler-runtime': 0.22.0

  '@module-federation/runtime@0.22.0':
    dependencies:
      '@module-federation/error-codes': 0.22.0
      '@module-federation/runtime-core': 0.22.0
      '@module-federation/sdk': 0.22.0

  '@module-federation/sdk@0.22.0': {}

  '@module-federation/webpack-bundler-runtime@0.22.0':
    dependencies:
      '@module-federation/runtime': 0.22.0
      '@module-federation/sdk': 0.22.0

  '@napi-rs/wasm-runtime@1.0.7':
    dependencies:
      '@emnapi/core': 1.11.3
      '@emnapi/runtime': 1.11.3
      '@tybys/wasm-util': 0.10.3
    optional: true

  '@remotion/bundler@4.0.468(postcss@8.5.26)(react-dom@18.3.1(react@18.3.1))(react@18.3.1)':
    dependencies:
      '@remotion/media-parser': 4.0.468
      '@remotion/studio': 4.0.468(react-dom@18.3.1(react@18.3.1))(react@18.3.1)
      '@remotion/studio-shared': 4.0.468(react-dom@18.3.1(react@18.3.1))(react@18.3.1)
      '@remotion/timeline-utils': 4.0.468
      '@rspack/core': 1.7.6
      '@rspack/plugin-react-refresh': 1.6.1(react-refresh@0.18.0)
      css-loader: 7.1.4(@rspack/core@1.7.6)(webpack@5.105.0(esbuild@0.28.0)(postcss@8.5.26))
      esbuild: 0.28.0
      react: 18.3.1
      react-dom: 18.3.1(react@18.3.1)
      react-refresh: 0.18.0
      remotion: 4.0.468(react-dom@18.3.1(react@18.3.1))(react@18.3.1)
      style-loader: 4.0.0(webpack@5.105.0(esbuild@0.28.0)(postcss@8.5.26))
      webpack: 5.105.0(esbuild@0.28.0)(postcss@8.5.26)
    transitivePeerDependencies:
      - '@minify-html/node'
      - '@swc/core'
      - '@swc/css'
      - '@swc/helpers'
      - '@swc/html'
      - bufferutil
      - clean-css
      - cssnano
      - csso
      - html-minifier-terser
      - lightningcss
      - postcss
      - uglify-js
      - utf-8-validate
      - webpack-cli
      - webpack-hot-middleware

  '@remotion/compositor-darwin-arm64@4.0.468':
    optional: true

  '@remotion/compositor-darwin-x64@4.0.468':
    optional: true

  '@remotion/compositor-linux-arm64-gnu@4.0.468':
    optional: true

  '@remotion/compositor-linux-arm64-musl@4.0.468':
    optional: true

  '@remotion/compositor-linux-x64-gnu@4.0.468':
    optional: true

  '@remotion/compositor-linux-x64-musl@4.0.468':
    optional: true

  '@remotion/compositor-win32-x64-msvc@4.0.468':
    optional: true

  '@remotion/licensing@4.0.468': {}

  '@remotion/media-parser@4.0.468': {}

  '@remotion/media-utils@4.0.468(react-dom@18.3.1(react@18.3.1))(react@18.3.1)':
    dependencies:
      mediabunny: 1.45.0
      react: 18.3.1
      react-dom: 18.3.1(react@18.3.1)
      remotion: 4.0.468(react-dom@18.3.1(react@18.3.1))(react@18.3.1)

  '@remotion/player@4.0.468(react-dom@18.3.1(react@18.3.1))(react@18.3.1)':
    dependencies:
      react: 18.3.1
      react-dom: 18.3.1(react@18.3.1)
      remotion: 4.0.468(react-dom@18.3.1(react@18.3.1))(react@18.3.1)

  '@remotion/renderer@4.0.468(react-dom@18.3.1(react@18.3.1))(react@18.3.1)':
    dependencies:
      '@remotion/licensing': 4.0.468
      '@remotion/streaming': 4.0.468
      execa: 5.1.1
      react: 18.3.1
      react-dom: 18.3.1(react@18.3.1)
      remotion: 4.0.468(react-dom@18.3.1(react@18.3.1))(react@18.3.1)
      source-map: 0.8.0-beta.0
      ws: 8.20.1
    optionalDependencies:
      '@remotion/compositor-darwin-arm64': 4.0.468
      '@remotion/compositor-darwin-x64': 4.0.468
      '@remotion/compositor-linux-arm64-gnu': 4.0.468
      '@remotion/compositor-linux-arm64-musl': 4.0.468
      '@remotion/compositor-linux-x64-gnu': 4.0.468
      '@remotion/compositor-linux-x64-musl': 4.0.468
      '@remotion/compositor-win32-x64-msvc': 4.0.468
    transitivePeerDependencies:
      - bufferutil
      - utf-8-validate

  '@remotion/streaming@4.0.468': {}

  '@remotion/studio-shared@4.0.468(react-dom@18.3.1(react@18.3.1))(react@18.3.1)':
    dependencies:
      remotion: 4.0.468(react-dom@18.3.1(react@18.3.1))(react@18.3.1)
    transitivePeerDependencies:
      - react
      - react-dom

  '@remotion/studio@4.0.468(react-dom@18.3.1(react@18.3.1))(react@18.3.1)':
    dependencies:
      '@jridgewell/trace-mapping': 0.3.31
      '@remotion/media-utils': 4.0.468(react-dom@18.3.1(react@18.3.1))(react@18.3.1)
      '@remotion/player': 4.0.468(react-dom@18.3.1(react@18.3.1))(react@18.3.1)
      '@remotion/renderer': 4.0.468(react-dom@18.3.1(react@18.3.1))(react@18.3.1)
      '@remotion/studio-shared': 4.0.468(react-dom@18.3.1(react@18.3.1))(react@18.3.1)
      '@remotion/timeline-utils': 4.0.468
      '@remotion/web-renderer': 4.0.468(react-dom@18.3.1(react@18.3.1))(react@18.3.1)
      '@remotion/zod-types': 4.0.468(react-dom@18.3.1(react@18.3.1))(react@18.3.1)(zod@4.3.6)
      mediabunny: 1.45.0
      memfs: 3.4.3
      open: 8.4.2
      react: 18.3.1
      react-dom: 18.3.1(react@18.3.1)
      remotion: 4.0.468(react-dom@18.3.1(react@18.3.1))(react@18.3.1)
      semver: 7.5.3
      zod: 4.3.6
    transitivePeerDependencies:
      - bufferutil
      - utf-8-validate

  '@remotion/timeline-utils@4.0.468':
    dependencies:
      mediabunny: 1.45.0

  '@remotion/web-renderer@4.0.468(react-dom@18.3.1(react@18.3.1))(react@18.3.1)':
    dependencies:
      '@mediabunny/aac-encoder': 1.45.0(mediabunny@1.45.0)
      '@mediabunny/flac-encoder': 1.45.0(mediabunny@1.45.0)
      '@mediabunny/mp3-encoder': 1.45.0(mediabunny@1.45.0)
      '@remotion/licensing': 4.0.468
      mediabunny: 1.45.0
      react: 18.3.1
      react-dom: 18.3.1(react@18.3.1)
      remotion: 4.0.468(react-dom@18.3.1(react@18.3.1))(react@18.3.1)

  '@remotion/zod-types@4.0.468(react-dom@18.3.1(react@18.3.1))(react@18.3.1)(zod@4.3.6)':
    dependencies:
      remotion: 4.0.468(react-dom@18.3.1(react@18.3.1))(react@18.3.1)
      zod: 4.3.6
    transitivePeerDependencies:
      - react
      - react-dom

  '@rspack/binding-darwin-arm64@1.7.6':
    optional: true

  '@rspack/binding-darwin-x64@1.7.6':
    optional: true

  '@rspack/binding-linux-arm64-gnu@1.7.6':
    optional: true

  '@rspack/binding-linux-arm64-musl@1.7.6':
    optional: true

  '@rspack/binding-linux-x64-gnu@1.7.6':
    optional: true

  '@rspack/binding-linux-x64-musl@1.7.6':
    optional: true

  '@rspack/binding-wasm32-wasi@1.7.6':
    dependencies:
      '@napi-rs/wasm-runtime': 1.0.7
    optional: true

  '@rspack/binding-win32-arm64-msvc@1.7.6':
    optional: true

  '@rspack/binding-win32-ia32-msvc@1.7.6':
    optional: true

  '@rspack/binding-win32-x64-msvc@1.7.6':
    optional: true

  '@rspack/binding@1.7.6':
    optionalDependencies:
      '@rspack/binding-darwin-arm64': 1.7.6
      '@rspack/binding-darwin-x64': 1.7.6
      '@rspack/binding-linux-arm64-gnu': 1.7.6
      '@rspack/binding-linux-arm64-musl': 1.7.6
      '@rspack/binding-linux-x64-gnu': 1.7.6
      '@rspack/binding-linux-x64-musl': 1.7.6
      '@rspack/binding-wasm32-wasi': 1.7.6
      '@rspack/binding-win32-arm64-msvc': 1.7.6
      '@rspack/binding-win32-ia32-msvc': 1.7.6
      '@rspack/binding-win32-x64-msvc': 1.7.6

  '@rspack/core@1.7.6':
    dependencies:
      '@module-federation/runtime-tools': 0.22.0
      '@rspack/binding': 1.7.6
      '@rspack/lite-tapable': 1.1.0

  '@rspack/lite-tapable@1.1.0': {}

  '@rspack/plugin-react-refresh@1.6.1(react-refresh@0.18.0)':
    dependencies:
      error-stack-parser: 2.1.4
      html-entities: 2.6.0
      react-refresh: 0.18.0

  '@tybys/wasm-util@0.10.3':
    dependencies:
      tslib: 2.8.1
    optional: true

  '@types/dom-mediacapture-transform@0.1.12':
    dependencies:
      '@types/dom-webcodecs': 0.1.13

  '@types/dom-webcodecs@0.1.13': {}

  '@types/eslint-scope@3.7.7':
    dependencies:
      '@types/eslint': 9.6.1
      '@types/estree': 1.0.9

  '@types/eslint@9.6.1':
    dependencies:
      '@types/estree': 1.0.9
      '@types/json-schema': 7.0.15

  '@types/estree@1.0.9': {}

  '@types/json-schema@7.0.15': {}

  '@types/node@26.4.0':
    dependencies:
      undici-types: 8.3.0

  '@types/prop-types@15.7.15': {}

  '@types/react-dom@18.3.5(@types/react@18.3.18)':
    dependencies:
      '@types/react': 18.3.18

  '@types/react@18.3.18':
    dependencies:
      '@types/prop-types': 15.7.15
      csstype: 3.2.3

  '@webassemblyjs/ast@1.14.1':
    dependencies:
      '@webassemblyjs/helper-numbers': 1.13.2
      '@webassemblyjs/helper-wasm-bytecode': 1.13.2

  '@webassemblyjs/floating-point-hex-parser@1.13.2': {}

  '@webassemblyjs/helper-api-error@1.13.2': {}

  '@webassemblyjs/helper-buffer@1.14.1': {}

  '@webassemblyjs/helper-numbers@1.13.2':
    dependencies:
      '@webassemblyjs/floating-point-hex-parser': 1.13.2
      '@webassemblyjs/helper-api-error': 1.13.2
      '@xtuc/long': 4.2.2

  '@webassemblyjs/helper-wasm-bytecode@1.13.2': {}

  '@webassemblyjs/helper-wasm-section@1.14.1':
    dependencies:
      '@webassemblyjs/ast': 1.14.1
      '@webassemblyjs/helper-buffer': 1.14.1
      '@webassemblyjs/helper-wasm-bytecode': 1.13.2
      '@webassemblyjs/wasm-gen': 1.14.1

  '@webassemblyjs/ieee754@1.13.2':
    dependencies:
      '@xtuc/ieee754': 1.2.0

  '@webassemblyjs/leb128@1.13.2':
    dependencies:
      '@xtuc/long': 4.2.2

  '@webassemblyjs/utf8@1.13.2': {}

  '@webassemblyjs/wasm-edit@1.14.1':
    dependencies:
      '@webassemblyjs/ast': 1.14.1
      '@webassemblyjs/helper-buffer': 1.14.1
      '@webassemblyjs/helper-wasm-bytecode': 1.13.2
      '@webassemblyjs/helper-wasm-section': 1.14.1
      '@webassemblyjs/wasm-gen': 1.14.1
      '@webassemblyjs/wasm-opt': 1.14.1
      '@webassemblyjs/wasm-parser': 1.14.1
      '@webassemblyjs/wast-printer': 1.14.1

  '@webassemblyjs/wasm-gen@1.14.1':
    dependencies:
      '@webassemblyjs/ast': 1.14.1
      '@webassemblyjs/helper-wasm-bytecode': 1.13.2
      '@webassemblyjs/ieee754': 1.13.2
      '@webassemblyjs/leb128': 1.13.2
      '@webassemblyjs/utf8': 1.13.2

  '@webassemblyjs/wasm-opt@1.14.1':
    dependencies:
      '@webassemblyjs/ast': 1.14.1
      '@webassemblyjs/helper-buffer': 1.14.1
      '@webassemblyjs/wasm-gen': 1.14.1
      '@webassemblyjs/wasm-parser': 1.14.1

  '@webassemblyjs/wasm-parser@1.14.1':
    dependencies:
      '@webassemblyjs/ast': 1.14.1
      '@webassemblyjs/helper-api-error': 1.13.2
      '@webassemblyjs/helper-wasm-bytecode': 1.13.2
      '@webassemblyjs/ieee754': 1.13.2
      '@webassemblyjs/leb128': 1.13.2
      '@webassemblyjs/utf8': 1.13.2

  '@webassemblyjs/wast-printer@1.14.1':
    dependencies:
      '@webassemblyjs/ast': 1.14.1
      '@xtuc/long': 4.2.2

  '@xtuc/ieee754@1.2.0': {}

  '@xtuc/long@4.2.2': {}

  acorn-import-phases@1.0.4(acorn@8.18.0):
    dependencies:
      acorn: 8.18.0

  acorn@8.18.0: {}

  ajv-formats@2.1.1(ajv@8.20.0):
    optionalDependencies:
      ajv: 8.20.0

  ajv-keywords@5.1.0(ajv@8.20.0):
    dependencies:
      ajv: 8.20.0
      fast-deep-equal: 3.1.3

  ajv@8.20.0:
    dependencies:
      fast-deep-equal: 3.1.3
      fast-uri: 3.1.6
      json-schema-traverse: 1.0.0
      require-from-string: 2.0.2

  baseline-browser-mapping@2.11.20: {}

  browserslist@4.28.8:
    dependencies:
      baseline-browser-mapping: 2.11.20
      caniuse-lite: 1.0.30001810
      electron-to-chromium: 1.5.417
      node-releases: 2.0.54
      update-browserslist-db: 1.3.2(browserslist@4.28.8)

  buffer-from@1.1.2: {}

  caniuse-lite@1.0.30001810: {}

  chrome-trace-event@1.0.4: {}

  commander@2.20.3: {}

  cross-spawn@7.0.6:
    dependencies:
      path-key: 3.1.1
      shebang-command: 2.0.0
      which: 2.0.2

  css-loader@7.1.4(@rspack/core@1.7.6)(webpack@5.105.0(esbuild@0.28.0)(postcss@8.5.26)):
    dependencies:
      icss-utils: 5.1.0(postcss@8.5.26)
      postcss: 8.5.26
      postcss-modules-extract-imports: 3.1.0(postcss@8.5.26)
      postcss-modules-local-by-default: 4.2.0(postcss@8.5.26)
      postcss-modules-scope: 3.2.1(postcss@8.5.26)
      postcss-modules-values: 4.0.0(postcss@8.5.26)
      postcss-value-parser: 4.2.0
      semver: 7.8.5
    optionalDependencies:
      '@rspack/core': 1.7.6
      webpack: 5.105.0(esbuild@0.28.0)(postcss@8.5.26)

  cssesc@3.0.0: {}

  csstype@3.2.3: {}

  define-lazy-prop@2.0.0: {}

  electron-to-chromium@1.5.417: {}

  enhanced-resolve@5.24.5:
    dependencies:
      graceful-fs: 4.2.11
      tapable: 2.3.3

  error-stack-parser@2.1.4:
    dependencies:
      stackframe: 1.3.4

  es-module-lexer@2.3.2: {}

  esbuild@0.28.0:
    optionalDependencies:
      '@esbuild/aix-ppc64': 0.28.0
      '@esbuild/android-arm': 0.28.0
      '@esbuild/android-arm64': 0.28.0
      '@esbuild/android-x64': 0.28.0
      '@esbuild/darwin-arm64': 0.28.0
      '@esbuild/darwin-x64': 0.28.0
      '@esbuild/freebsd-arm64': 0.28.0
      '@esbuild/freebsd-x64': 0.28.0
      '@esbuild/linux-arm': 0.28.0
      '@esbuild/linux-arm64': 0.28.0
      '@esbuild/linux-ia32': 0.28.0
      '@esbuild/linux-loong64': 0.28.0
      '@esbuild/linux-mips64el': 0.28.0
      '@esbuild/linux-ppc64': 0.28.0
      '@esbuild/linux-riscv64': 0.28.0
      '@esbuild/linux-s390x': 0.28.0
      '@esbuild/linux-x64': 0.28.0
      '@esbuild/netbsd-arm64': 0.28.0
      '@esbuild/netbsd-x64': 0.28.0
      '@esbuild/openbsd-arm64': 0.28.0
      '@esbuild/openbsd-x64': 0.28.0
      '@esbuild/openharmony-arm64': 0.28.0
      '@esbuild/sunos-x64': 0.28.0
      '@esbuild/win32-arm64': 0.28.0
      '@esbuild/win32-ia32': 0.28.0
      '@esbuild/win32-x64': 0.28.0

  escalade@3.2.0: {}

  eslint-scope@5.1.1:
    dependencies:
      esrecurse: 4.3.0
      estraverse: 4.3.0

  esrecurse@4.3.0:
    dependencies:
      estraverse: 5.3.0

  estraverse@4.3.0: {}

  estraverse@5.3.0: {}

  events@3.3.0: {}

  execa@5.1.1:
    dependencies:
      cross-spawn: 7.0.6
      get-stream: 6.0.1
      human-signals: 2.1.0
      is-stream: 2.0.1
      merge-stream: 2.0.0
      npm-run-path: 4.0.1
      onetime: 5.1.2
      signal-exit: 3.0.7
      strip-final-newline: 2.0.0

  fast-deep-equal@3.1.3: {}

  fast-uri@3.1.6: {}

  fs-monkey@1.0.3: {}

  get-stream@6.0.1: {}

  glob-to-regexp@0.4.1: {}

  graceful-fs@4.2.11: {}

  has-flag@4.0.0: {}

  html-entities@2.6.0: {}

  human-signals@2.1.0: {}

  icss-utils@5.1.0(postcss@8.5.26):
    dependencies:
      postcss: 8.5.26

  is-docker@2.2.1: {}

  is-stream@2.0.1: {}

  is-wsl@2.2.0:
    dependencies:
      is-docker: 2.2.1

  isexe@2.0.0: {}

  jest-worker@27.5.1:
    dependencies:
      '@types/node': 26.4.0
      merge-stream: 2.0.0
      supports-color: 8.1.1

  js-tokens@4.0.0: {}

  json-parse-even-better-errors@2.3.1: {}

  json-schema-traverse@1.0.0: {}

  loader-runner@4.3.2: {}

  lodash.sortby@4.7.0: {}

  loose-envify@1.4.0:
    dependencies:
      js-tokens: 4.0.0

  lru-cache@6.0.0:
    dependencies:
      yallist: 4.0.0

  mediabunny@1.45.0:
    dependencies:
      '@types/dom-mediacapture-transform': 0.1.12
      '@types/dom-webcodecs': 0.1.13

  memfs@3.4.3:
    dependencies:
      fs-monkey: 1.0.3

  merge-stream@2.0.0: {}

  mime-db@1.52.0: {}

  mime-types@2.1.35:
    dependencies:
      mime-db: 1.52.0

  mimic-fn@2.1.0: {}

  nanoid@3.3.18: {}

  neo-async@2.6.2: {}

  node-releases@2.0.54: {}

  npm-run-path@4.0.1:
    dependencies:
      path-key: 3.1.1

  onetime@5.1.2:
    dependencies:
      mimic-fn: 2.1.0

  open@8.4.2:
    dependencies:
      define-lazy-prop: 2.0.0
      is-docker: 2.2.1
      is-wsl: 2.2.0

  path-key@3.1.1: {}

  picocolors@1.1.1: {}

  postcss-modules-extract-imports@3.1.0(postcss@8.5.26):
    dependencies:
      postcss: 8.5.26

  postcss-modules-local-by-default@4.2.0(postcss@8.5.26):
    dependencies:
      icss-utils: 5.1.0(postcss@8.5.26)
      postcss: 8.5.26
      postcss-selector-parser: 7.1.5
      postcss-value-parser: 4.2.0

  postcss-modules-scope@3.2.1(postcss@8.5.26):
    dependencies:
      postcss: 8.5.26
      postcss-selector-parser: 7.1.5

  postcss-modules-values@4.0.0(postcss@8.5.26):
    dependencies:
      icss-utils: 5.1.0(postcss@8.5.26)
      postcss: 8.5.26

  postcss-selector-parser@7.1.5:
    dependencies:
      cssesc: 3.0.0
      util-deprecate: 1.0.2

  postcss-value-parser@4.2.0: {}

  postcss@8.5.26:
    dependencies:
      nanoid: 3.3.18
      picocolors: 1.1.1
      source-map-js: 1.2.1

  punycode@2.3.1: {}

  react-dom@18.3.1(react@18.3.1):
    dependencies:
      loose-envify: 1.4.0
      react: 18.3.1
      scheduler: 0.23.2

  react-refresh@0.18.0: {}

  react@18.3.1:
    dependencies:
      loose-envify: 1.4.0

  remotion@4.0.468(react-dom@18.3.1(react@18.3.1))(react@18.3.1):
    dependencies:
      react: 18.3.1
      react-dom: 18.3.1(react@18.3.1)

  require-from-string@2.0.2: {}

  scheduler@0.23.2:
    dependencies:
      loose-envify: 1.4.0

  schema-utils@4.3.3:
    dependencies:
      '@types/json-schema': 7.0.15
      ajv: 8.20.0
      ajv-formats: 2.1.1(ajv@8.20.0)
      ajv-keywords: 5.1.0(ajv@8.20.0)

  semver@7.5.3:
    dependencies:
      lru-cache: 6.0.0

  semver@7.8.5: {}

  shebang-command@2.0.0:
    dependencies:
      shebang-regex: 3.0.0

  shebang-regex@3.0.0: {}

  signal-exit@3.0.7: {}

  source-map-js@1.2.1: {}

  source-map-support@0.5.21:
    dependencies:
      buffer-from: 1.1.2
      source-map: 0.6.1

  source-map@0.6.1: {}

  source-map@0.8.0-beta.0:
    dependencies:
      whatwg-url: 7.1.0

  stackframe@1.3.4: {}

  strip-final-newline@2.0.0: {}

  style-loader@4.0.0(webpack@5.105.0(esbuild@0.28.0)(postcss@8.5.26)):
    dependencies:
      webpack: 5.105.0(esbuild@0.28.0)(postcss@8.5.26)

  supports-color@8.1.1:
    dependencies:
      has-flag: 4.0.0

  tapable@2.3.3: {}

  terser-webpack-plugin@5.6.1(esbuild@0.28.0)(postcss@8.5.26)(webpack@5.105.0(postcss@8.5.26)):
    dependencies:
      '@jridgewell/trace-mapping': 0.3.31
      jest-worker: 27.5.1
      schema-utils: 4.3.3
      terser: 5.51.2
      webpack: 5.105.0(esbuild@0.28.0)(postcss@8.5.26)
    optionalDependencies:
      esbuild: 0.28.0
      postcss: 8.5.26

  terser@5.51.2:
    dependencies:
      '@jridgewell/source-map': 0.3.11
      acorn: 8.18.0
      commander: 2.20.3
      source-map-support: 0.5.21

  tr46@1.0.1:
    dependencies:
      punycode: 2.3.1

  tslib@2.8.1:
    optional: true

  typescript@5.9.2: {}

  undici-types@8.3.0: {}

  update-browserslist-db@1.3.2(browserslist@4.28.8):
    dependencies:
      browserslist: 4.28.8
      escalade: 3.2.0
      picocolors: 1.1.1

  util-deprecate@1.0.2: {}

  watchpack@2.5.2:
    dependencies:
      graceful-fs: 4.2.11

  webidl-conversions@4.0.2: {}

  webpack-sources@3.5.1: {}

  webpack@5.105.0(esbuild@0.28.0)(postcss@8.5.26):
    dependencies:
      '@types/eslint-scope': 3.7.7
      '@types/estree': 1.0.9
      '@types/json-schema': 7.0.15
      '@webassemblyjs/ast': 1.14.1
      '@webassemblyjs/wasm-edit': 1.14.1
      '@webassemblyjs/wasm-parser': 1.14.1
      acorn: 8.18.0
      acorn-import-phases: 1.0.4(acorn@8.18.0)
      browserslist: 4.28.8
      chrome-trace-event: 1.0.4
      enhanced-resolve: 5.24.5
      es-module-lexer: 2.3.2
      eslint-scope: 5.1.1
      events: 3.3.0
      glob-to-regexp: 0.4.1
      graceful-fs: 4.2.11
      json-parse-even-better-errors: 2.3.1
      loader-runner: 4.3.2
      mime-types: 2.1.35
      neo-async: 2.6.2
      schema-utils: 4.3.3
      tapable: 2.3.3
      terser-webpack-plugin: 5.6.1(esbuild@0.28.0)(postcss@8.5.26)(webpack@5.105.0(postcss@8.5.26))
      watchpack: 2.5.2
      webpack-sources: 3.5.1
    transitivePeerDependencies:
      - '@minify-html/node'
      - '@swc/core'
      - '@swc/css'
      - '@swc/html'
      - clean-css
      - cssnano
      - csso
      - esbuild
      - html-minifier-terser
      - lightningcss
      - postcss
      - uglify-js

  whatwg-url@7.1.0:
    dependencies:
      lodash.sortby: 4.7.0
      tr46: 1.0.1
      webidl-conversions: 4.0.2

  which@2.0.2:
    dependencies:
      isexe: 2.0.0

  ws@8.20.1: {}

  yallist@4.0.0: {}

  zod@4.3.6: {}
`;
