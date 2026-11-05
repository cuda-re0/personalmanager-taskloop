import { describe, expect, it } from 'vitest'
import { parseTemperature, pickTemperatures } from '../../src/main/services/sensorService'

/**
 * 温度解析（v0.62）：只测两个纯函数，**不碰网络**。
 * `readSensors` 的 HTTP / nvidia-smi 兜底靠真机验收，这里不 mock。
 */

/** 手写的小树（不是真实 84KB）：CPU Package + 两个干扰项，够验"前缀 + Text"双条件 */
const SAMPLE = JSON.stringify({
  Text: 'Sensor',
  Children: [
    {
      Text: 'Gigabyte Z790',
      Children: [
        {
          Text: 'Intel Core i7',
          Children: [
            {
              Text: 'Temperatures',
              Children: [
                {
                  Text: 'CPU Package',
                  SensorId: '/intelcpu/0/temperature/26',
                  Type: 'Temperature',
                  Value: '61.0 °C'
                },
                {
                  Text: 'Core Max',
                  SensorId: '/intelcpu/0/temperature/0',
                  Type: 'Temperature',
                  Value: '62.0 °C'
                }
              ]
            }
          ]
        }
      ]
    },
    {
      Text: 'NVIDIA GeForce RTX 4070',
      Children: [
        {
          Text: 'Temperatures',
          Children: [
            {
              Text: 'GPU Core',
              SensorId: '/gpu-nvidia/0/temperature/0',
              Type: 'Temperature',
              Value: '54.0 °C'
            }
          ]
        }
      ]
    },
    {
      Text: 'DIMM #1',
      SensorId: '/memory/dimm/1/temperature/0',
      Type: 'Temperature',
      Value: '47.0 °C'
    }
  ]
})

describe('温度解析（v0.62：整数摄氏，1..125）', () => {
  it('parseTemperature / pickTemperatures 的全部口径', () => {
    // 常规值与 locale 逗号（LHM 的 Value 是 locale 格式化过的）
    expect(parseTemperature('62.0 °C')).toBe(62)
    expect(parseTemperature('62,0 °C')).toBe(62)
    // 取整：95.4 → 95
    expect(parseTemperature('95.4 °C')).toBe(95)

    // 0.0 是"没读到"不是零度（下限 1）；超 125 是坏值
    expect(parseTemperature('0.0 °C')).toBeNull()
    expect(parseTemperature('999 °C')).toBeNull()

    // 非字符串 / 空串 / 没有数字
    expect(parseTemperature(null)).toBeNull()
    expect(parseTemperature(42)).toBeNull()
    expect(parseTemperature('')).toBeNull()
    expect(parseTemperature('abc')).toBeNull()

    // 前缀 + Text 双条件：跳过 Core Max（Text 不对）与 DIMM #1（前缀不对）
    expect(pickTemperatures(SAMPLE)).toEqual({ cpu: 61, gpu: 54 })

    // 坏 JSON / 空对象**不许抛**，两路都是 null
    expect(pickTemperatures('不是 json')).toEqual({ cpu: null, gpu: null })
    expect(pickTemperatures('{}')).toEqual({ cpu: null, gpu: null })
  })
})
